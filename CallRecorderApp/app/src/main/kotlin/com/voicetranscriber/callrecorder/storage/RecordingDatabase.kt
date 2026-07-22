package com.voicetranscriber.callrecorder.storage

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [RecordingEntity::class], version = 4, exportSchema = false)
abstract class RecordingDatabase : RoomDatabase() {
    abstract fun recordingDao(): RecordingDao

    companion object {
        @Volatile private var instance: RecordingDatabase? = null

        // v2 → v3 adds the editable `note` column; keep existing recordings.
        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE recordings ADD COLUMN note TEXT")
            }
        }

        // v3 → v4 adds the upload-subsystem columns. NOT NULL columns carry a
        // DEFAULT so existing rows migrate cleanly; nullable ones default to NULL.
        private val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE recordings ADD COLUMN uploadState TEXT NOT NULL DEFAULT 'PENDING'")
                db.execSQL("ALTER TABLE recordings ADD COLUMN remoteCallId TEXT")
                db.execSQL("ALTER TABLE recordings ADD COLUMN attemptCount INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE recordings ADD COLUMN lastError TEXT")
                db.execSQL("ALTER TABLE recordings ADD COLUMN sha256 TEXT")
                db.execSQL("ALTER TABLE recordings ADD COLUMN bytesUploaded INTEGER NOT NULL DEFAULT 0")
            }
        }

        fun get(context: Context): RecordingDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    RecordingDatabase::class.java,
                    "recordings.db",
                )
                    .addMigrations(MIGRATION_2_3, MIGRATION_3_4)
                    // Safety net for older/dev schemas without a written migration.
                    .fallbackToDestructiveMigration()
                    .build().also { instance = it }
            }
    }
}
