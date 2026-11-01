import java.util.Properties
// Code adapted from Morphe Manager; see third-party/NOTICE.txt.
// https://github.com/MorpheApp/morphe-manager/pull/1302
plugins { alias(libs.plugins.android.application) }
val runtimeVersion = Properties().apply { project.file("version.properties").inputStream().use(::load) }
// Hybrid JVM layout adapted from Morphe PR #1302: keep the stable ARM32 JIT.
data class EmbeddedJvm(val feature: Int, val file: String, val sha256: String, val platform: String) {
    val url get() = "https://github.com/AngelAuraMC/angelauramc-openjdk-build/releases/download/download_jre$feature/$file"
}
val embeddedJvms = mapOf(
    "arm64-v8a" to EmbeddedJvm(25, "jre25-android-arm64.tar.xz", "d3eb7afe2240c26728a1bb440502c5f18ac3883e932d202dd7f0c9bcbbce4c37", "linux-aarch64"),
    "armeabi-v7a" to EmbeddedJvm(17, "jre17-android-arm.tar.xz", "4a9134f1ebf6340dd855805d351712462cddab6f3c2684da7e7da10ccf06648d", "linux-arm"),
    "x86_64" to EmbeddedJvm(25, "jre25-android-x86_64.tar.xz", "7fca862ee1b2d5fe23cd9c9c3d9b7ad3c241947ad1a6cc9464ef2e674867105d", "linux-amd64")
)

/**
 * The modules patching can reach: what the patcher and its libraries use, plus what ART offers patches
 * beyond that, so a patch that runs inside the app also runs in the JVM.
 */
val embeddedJvmModules = listOf(
    "java.base", "java.logging", "java.xml", "java.sql", "jdk.unsupported", "jdk.charsets", "jdk.crypto.ec",
    // GC collection time used to fail runs whose heap is too small.
    "java.management",
    // Apktool decodes nine-patch PNGs using Raster, BufferedImage and ImageIO.
    "java.desktop"
)

/**
 * What of the build the linked modules need, its native libraries above all. The 64 bit builds
 * ship the server VM, the 32-bit ARM one only the client VM.
 */
val embeddedJvmFiles = listOf(
    "lib/*/libjvm.so",
    "lib/libjava.so", "lib/libjimage.so", "lib/libzip.so", "lib/libnet.so", "lib/libnio.so",
    "lib/libverify.so", "lib/libmanagement.so", "lib/libprefs.so",
    // JDK 25 resolves java.base native symbols through this library.
    "lib/libsyslookup.so",
    // Headless AWT and ImageIO still need native image and font support on Android.
    "lib/libawt.so", "lib/libawt_headless.so", "lib/libjavajpeg.so",
    "lib/libfontmanager.so", "lib/libfreetype.so", "lib/liblcms.so", "lib/libmlib_image.so",
    "lib/fontconfig*", "lib/psfont*",
    "lib/jvm.cfg", "lib/tzdb.dat", "lib/security", "conf"
)

val embeddedJvmTasks = embeddedJvms.map { (abi, build) ->
    tasks.register<PrepareEmbeddedJvmTask>("prepareEmbeddedJvm${abi.replace("-", "").replace("_", "").replaceFirstChar(Char::uppercase)}") {
        group = "build"
        description = "Links the embedded JVM for $abi."
        url.set(build.url)
        sha256.set(build.sha256)
        targetPlatform.set(build.platform)
        modules.set(embeddedJvmModules)
        runtimeFiles.set(embeddedJvmFiles)
        jdk.set(javaToolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(build.feature)) })
        downloadCache.set(File(gradle.gradleUserHomeDir, "caches/urv-embedded-jvm"))
        outputArchive.set(layout.buildDirectory.file("intermediates/embeddedJvm/$abi.zip.xz"))
        outputImage.set(layout.buildDirectory.file("intermediates/embeddedJvm/$abi.modules"))
    }
}

/** The ABIs of [embeddedJvms] as a Java array literal for BuildConfig. */
val embeddedJvmAbis = embeddedJvms.keys.joinToString(prefix = "{", postfix = "}") { abi -> "\"$abi\"" }

/** Changes with whatever goes into the runtime, which the app then unpacks again. */
val embeddedJvmId = (listOf("shared-image-v1") + embeddedJvms.values.map { build -> build.sha256 } + embeddedJvmModules + embeddedJvmFiles)
    .hashCode().toUInt().toString(16)

/** Assets the embedded JVM runs from, read by JvmInstallation. */
val embeddedJvmAssets = tasks.register<EmbeddedJvmAssetsTask>("embeddedJvmAssets") {
    group = "build"
    description = "Lays out the embedded JVM runtimes and the patcher host as assets."
    runtimes.from(embeddedJvmTasks.map { it.flatMap { task -> task.outputArchive } })
    images.from(embeddedJvmTasks.map { it.flatMap { task -> task.outputImage } })
    baseAbi.set("arm64-v8a")
    hostJar.from(emptyList<File>())
    outputDirectory.set(layout.buildDirectory.dir("generated/embeddedJvm"))
}

val jvmHost by configurations.creating
val copyJvmHost = tasks.register<PluginJvmHostTask>("copyJvmHost") {
    hostJars.from(jvmHost)
    outputDirectory.set(layout.buildDirectory.dir("generated/jvmHost"))
}
android {
    namespace = "app.universal.patch.manager.support.runtime"
    compileSdk = 37
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "app.universal.patch.manager.support.runtime"
        minSdk = 26
        targetSdk = 36
        versionCode = runtimeVersion.getProperty("versionCode").toInt()
        versionName = runtimeVersion.getProperty("versionName")
        manifestPlaceholders["runtimeUpstreamVersion"] = "OpenJDK 25 / 17"
    }
    val keystoreFile = rootProject.file("keystore.jks")
    val password = System.getenv("KEYSTORE_PASSWORD")
    val alias = System.getenv("KEYSTORE_ENTRY_ALIAS")
    val entryPassword = System.getenv("KEYSTORE_ENTRY_PASSWORD")
    val hasCredentials = keystoreFile.exists() && !password.isNullOrBlank() && !alias.isNullOrBlank() && !entryPassword.isNullOrBlank()
    if (System.getenv("CI").toBoolean() && !project.hasProperty("signAsDebug") && !hasCredentials) {
        throw GradleException("Release signing credentials are required in CI.")
    }
    val signing = if (hasCredentials && !project.hasProperty("signAsDebug")) signingConfigs.create("release") {
        storeFile = keystoreFile
        storePassword = password
        keyAlias = alias
        keyPassword = entryPassword
    } else signingConfigs.getByName("debug")
    buildTypes {
        release { signingConfig = signing }
        debug { signingConfig = signing }
    }
    androidResources { noCompress += listOf("xz", "jar") }
}
dependencies { jvmHost(project(":tools-patcher-core", "hostJar")) }
androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(embeddedJvmAssets, EmbeddedJvmAssetsTask::outputDirectory)
        variant.sources.assets?.addGeneratedSourceDirectory(copyJvmHost, PluginJvmHostTask::outputDirectory)
        variant.outputs.forEach { it.outputFileName.set("shared-support-plugin.apk") }
    }
}
