package com.voicetranscriber.callrecorder.transcription

import java.io.File

/**
 * Pluggable transcription backend. You chose "decide later", so the pipeline talks
 * to this interface and the concrete engine is swapped in one place ([active]).
 *
 * Candidate implementations:
 *  • On-device offline: Whisper (whisper.cpp via JNI) or Vosk — private, no per-use
 *    cost, works offline; larger app, heavier CPU.
 *  • Cloud STT: post the file to a hosted speech-to-text API — higher accuracy,
 *    tiny app, but needs network + has per-use cost and privacy trade-offs.
 */
interface Transcriber {
    /** Transcribe [audio] and return the text, or null on failure. Runs off the main thread. */
    suspend fun transcribe(audio: File): String?

    companion object {
        /** Set this once at startup to choose the backend. Null = transcription disabled. */
        @Volatile
        var active: Transcriber? = null
    }
}

/** Default no-op so the build runs before you wire a real engine. */
class NoopTranscriber : Transcriber {
    override suspend fun transcribe(audio: File): String? = null
}
