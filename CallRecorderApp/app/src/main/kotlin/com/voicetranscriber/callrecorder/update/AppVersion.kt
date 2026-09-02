package com.voicetranscriber.callrecorder.update

import android.content.Context
import android.content.pm.PackageInfo
import androidx.core.content.pm.PackageInfoCompat

/**
 * This build's own identity, read from the installed package rather than from
 * BuildConfig.
 *
 * That distinction matters after a self-update: BuildConfig is compiled in, so
 * it is whatever the *running* code was built as, while the package manager
 * reports what is actually installed. They agree in practice - but reading the
 * installed value is what makes "am I already on the build the server is
 * offering?" answerable, rather than assumed.
 */
object AppVersion {

    /**
     * The installed versionCode, or -1 if it cannot be read.
     *
     * -1 rather than 0 on purpose: the server treats a negative code as "tell
     * this device nothing", so a handset that somehow cannot read its own
     * version is left alone instead of being offered every build forever.
     * Failing closed here costs one missed update cycle; failing open would be
     * a permanent, un-dismissable prompt.
     */
    fun current(context: Context): Int =
        info(context)?.let { PackageInfoCompat.getLongVersionCode(it).toInt() } ?: -1

    /** Human-facing version, e.g. "1.1.0". Shown in the settings sheet. */
    fun currentName(context: Context): String = info(context)?.versionName ?: "unknown"

    private fun info(context: Context): PackageInfo? =
        try {
            context.packageManager.getPackageInfo(context.packageName, 0)
        } catch (_: Throwable) {
            null
        }
}
