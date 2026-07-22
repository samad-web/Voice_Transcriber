package com.voicetranscriber.callrecorder.upload

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Enqueues the [UploadWorker]. One unique job drains the whole PENDING/FAILED
 * queue, so callers can fire this after every saved recording without piling up
 * duplicate work.
 *
 * Wi-Fi-only is a future server-config item; for now any connected network is fine.
 */
object UploadScheduler {

    private const val UNIQUE_WORK = "call-upload"
    private const val UNIQUE_TRANSCRIPT = "call-transcript"

    fun enqueue(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context.applicationContext)
            .enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    /**
     * Polls the server for transcripts of uploaded calls (retries with backoff
     * while the pipeline is still processing) and stores them on the local rows.
     */
    fun enqueueTranscriptFetch(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = OneTimeWorkRequestBuilder<TranscriptWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.LINEAR, 15, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context.applicationContext)
            .enqueueUniqueWork(UNIQUE_TRANSCRIPT, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }
}
