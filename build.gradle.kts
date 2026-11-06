import java.util.zip.ZipInputStream
import java.util.zip.ZipFile
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.parcelize) apply false
}

// Only external SDK archives need the patcher merger transform. Mark project
// outputs too, including AGP's secondary class variants used by local unit tests.
// Otherwise those variants disappear from test classpaths, and clean builds can
// try to transform a project JAR before its producer task has run.
val patcherMergerCompatible = Attribute.of("app.upm.patcher-merger-compatible", Boolean::class.javaObjectType)
allprojects {
    configurations.configureEach {
        outgoing.attributes.attribute(patcherMergerCompatible, true)
        outgoing.variants.configureEach {
            attributes.attribute(patcherMergerCompatible, true)
        }
    }
}


// Verify runtime payload boundaries during the release build itself.
subprojects {
    plugins.withId("com.android.application") {
        tasks.matching { it.name == "assembleRelease" }.configureEach {
            doLast {
                val apks = fileTree(layout.buildDirectory.dir("outputs/apk/release")).matching { include("*.apk") }.files
                check(apks.size == 1) { "Expected one release plugin APK in $path" }
                apks.forEach { apk ->
                    ZipFile(apk).use { zip ->
                        val host = when (project.name) {
                            "morphe-runtime" -> "upm-patcher-core"
                            "revanced.v21-runtime-plugin" -> "revanced21-patcher-core"
                            "revanced.v22-runtime-plugin" -> "revanced22-patcher-core"
                            "shared-support" -> "tools-patcher-core"
                            else -> null
                        }
                        if (host != null) {
                            val entry = checkNotNull(zip.getEntry("assets/jvm/$host.jar")) { "Missing $host in ${apk.name}" }
                            ZipInputStream(zip.getInputStream(entry)).use { jar ->
                                val names = generateSequence { jar.nextEntry }.map { it.name }.toSet()
                                check(names.any { it.startsWith("frameworks/") }) { "$host has no framework resources" }
                                check("app/universal/patch/manager/patcher/host/GcOverheadWatch.class" in names) { "$host has no disposable worker support" }
                            }
                        }
                        if (project.name == "shared-support") {
                            check(zip.getEntry("assets/jvm/modules.xz") != null)
                            listOf("arm64-v8a", "armeabi-v7a", "x86_64").forEach { abi ->
                                check(zip.getEntry("assets/jvm/$abi.zip.xz") != null) { "Missing JVM image for $abi" }
                            }
                        } else {
                            check(zip.getEntry("classes.dex") != null) { "Runtime plugin has no ART payload" }
                        }
                    }
                }
            }
        }
    }
}
