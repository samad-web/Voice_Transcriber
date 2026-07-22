import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

/**
 * Release signing comes from keystore.properties (gitignored, next to this
 * file's parent) or, on a build server, from environment variables. When
 * neither is present the release signing config is simply not created, so
 * `assembleDebug` still works on a fresh checkout — only `assembleRelease`
 * fails, and it fails loudly rather than silently emitting an unsigned APK.
 */
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}
fun signingValue(key: String, env: String): String? =
    keystoreProps.getProperty(key) ?: System.getenv(env)

val releaseStoreFile = signingValue("storeFile", "ANDROID_KEYSTORE_FILE")
val hasReleaseSigning = releaseStoreFile != null && rootProject.file(releaseStoreFile).exists()

android {
    namespace = "com.voicetranscriber.callrecorder"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.voicetranscriber.callrecorder"
        minSdk = 26          // Android 8.0 — accessibility + AudioRecord baseline
        targetSdk = 34
        // Bump versionCode on EVERY release build that leaves this machine —
        // Android refuses to install an APK whose code is lower than the one
        // already on the device.
        versionCode = 2
        versionName = "1.0.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile!!)
                storePassword = signingValue("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "ANDROID_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "ANDROID_KEY_PASSWORD")
                // minSdk is 26, so v1/JAR signing (only needed below API 24) is
                // redundant — AGP drops it anyway. v2 is what gets verified.
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (hasReleaseSigning) signingConfigs.getByName("release") else null
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { viewBinding = true }
}

// An unsigned release APK cannot be installed and is easy to ship by accident —
// stop the build instead of producing app-release-unsigned.apk.
tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }.configureEach {
    doFirst {
        check(hasReleaseSigning) {
            "Release signing is not configured. Create CallRecorderApp/keystore.properties " +
                "(storeFile, storePassword, keyAlias, keyPassword) or set ANDROID_KEYSTORE_FILE, " +
                "ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD. " +
                "See DEPLOYMENT.md §5."
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    // Pull-to-refresh on the recordings list — re-runs the OEM ingest on demand, since the
    // automatic import only fires ~15s after a call ends and on a 15-minute cycle.
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-service:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // Metadata store (mirrors Cube ACR's Room DB)
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // Background upload subsystem (reuses HttpURLConnection; no OkHttp).
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // QR scanning for device activation (instance id + admin key).
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
