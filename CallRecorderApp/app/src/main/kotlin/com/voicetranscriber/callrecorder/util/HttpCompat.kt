package com.voicetranscriber.callrecorder.util

import java.net.HttpURLConnection

/**
 * ngrok's free tier answers the first request from a new client with an HTML
 * interstitial instead of the API response, which the parsers here read as
 * corrupt JSON. The documented opt-out is a request header.
 *
 * It used to be sent on every request. That leaked a development detail into
 * production traffic, so it is now scoped to hosts that are actually ngrok
 * tunnels — a no-op once the app points at the real domain.
 */
fun HttpURLConnection.applyNgrokBypass() {
    val host = url.host
    if (host.contains(".ngrok", ignoreCase = true)) {
        setRequestProperty("ngrok-skip-browser-warning", "true")
    }
}
