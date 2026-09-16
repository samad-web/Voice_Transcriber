# Keep Room entities/DAOs untouched (safety for release minify).
-keep class com.voicetranscriber.callrecorder.storage.** { *; }

# Firebase Messaging instantiates this by the name in AndroidManifest.xml.
# (AGP already keeps manifest-declared components; stated explicitly because
# the class has no other caller, so nothing in the source hints that deleting
# it would break silently rather than fail to compile.)
-keep class com.voicetranscriber.callrecorder.platform.AuraFirebaseMessagingService { *; }

# NOTE: firebase-messaging ships its own consumer ProGuard rules, so the
# `-keep class com.google.firebase.messaging.** { *; }` and blanket
# `-dontwarn com.google.firebase.**` that used to sit here were both redundant.
# They were removed rather than left as "safety nets": a blanket -dontwarn over
# a whole SDK suppresses exactly the missing-class warning that would tell us a
# future dependency change had broken the push path. Verified against the
# release build's mapping output - AuraFirebaseMessagingService is a seed, and
# kotlinx.coroutines.tasks.TasksKt (Task.await) survives with awaitImpl intact.
