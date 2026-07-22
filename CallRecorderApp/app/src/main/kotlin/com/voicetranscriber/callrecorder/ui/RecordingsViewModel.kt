package com.voicetranscriber.callrecorder.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.voicetranscriber.callrecorder.App
import com.voicetranscriber.callrecorder.storage.RecordingEntity
import com.voicetranscriber.callrecorder.util.RecordingNaming
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.io.File

class RecordingsViewModel(app: Application) : AndroidViewModel(app) {
    private val dao = (app as App).database.recordingDao()

    val recordings: StateFlow<List<RecordingEntity>> = dao.observeAll()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Remove the DB row and delete the underlying audio file. */
    fun delete(item: RecordingEntity) {
        viewModelScope.launch {
            dao.deleteById(item.id)
            runCatching { File(item.filePath).delete() }
        }
    }

    /** Bulk-remove several recordings (multi-select) and their audio files. */
    fun deleteMany(items: Collection<RecordingEntity>) {
        if (items.isEmpty()) return
        viewModelScope.launch {
            dao.deleteByIds(items.map { it.id })
            items.forEach { runCatching { File(it.filePath).delete() } }
        }
    }

    /** Edit the display name and note, and rename the file to match "<name> <date time>". */
    fun updateMeta(item: RecordingEntity, name: String?, note: String?) {
        viewModelScope.launch {
            val cleanName = name?.trim()?.ifBlank { null }
            val cleanNote = note?.trim()?.ifBlank { null }
            val newPath = RecordingNaming.renameToReadable(item.filePath, cleanName ?: item.callee, item.startedAt)
            dao.updateMeta(item.id, cleanName, cleanNote, newPath)
        }
    }
}
