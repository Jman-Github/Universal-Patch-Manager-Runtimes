import java.util.Properties
// Code adapted from Morphe Manager; see third-party/NOTICE.txt.
// https://github.com/MorpheApp/morphe-manager/pull/1302
plugins { alias(libs.plugins.android.application) }
val runtimeVersion = Properties().apply { project.file("version.properties").inputStream().use(::load) }
// Adapted from Morphe Manager for UPM's independently signed support APK.
// https://github.com/MorpheApp/morphe-manager/pull/1474
val libericaVersion = "25.0.5.1+5"
val glibcRelease = "gpkg-3"
val jvmArchiveDirectory = "liberica-$glibcRelease"
val embeddedJvmDownloads = File(gradle.gradleUserHomeDir, "caches/upm-embedded-jvm")

data class EmbeddedJvm(
    val platform: String,
    val sha256: String,
    val jmodPlatform: String,
    val termuxArch: String,
    val glibcPackages: Map<String, String>,
    val loader: String
) {
    val url get() = "https://github.com/bell-sw/Liberica/releases/download/$libericaVersion/bellsoft-jre$libericaVersion-$platform.tar.gz"
    val glibcUrls get() = glibcPackages.mapKeys { (name, _) ->
        "https://github.com/MorpheApp/morphe-jvm/releases/download/$glibcRelease/$name-$termuxArch.pkg.tar.xz"
    }
}

val embeddedJvms = mapOf(
    "arm64-v8a" to EmbeddedJvm(
        platform = "linux-aarch64",
        sha256 = "335eb057b9b9d7e2c2d62c86b3c042be3974808f9592af608542f949accdb3fa",
        jmodPlatform = "linux-aarch64",
        termuxArch = "aarch64",
        glibcPackages = mapOf(
            "glibc-2.44-0" to "a190d90f0d097465a49d7467d630da69f9be38dfb5d838cd46e258c3c1d762fb",
            "zlib-glibc-1.3.2-0" to "823322a4dfaccf77ead5935941320c53cf25f73d113253c53382ac6f42d7868b",
            "gcc-libs-glibc-14.2.1-1" to "9316728ceeb23c320756aa0bb03460f9767b6efdc44a478c86f7fcc44c6e11ec"
        ),
        loader = "ld-linux-aarch64.so.1"
    ),
    "armeabi-v7a" to EmbeddedJvm(
        platform = "linux-arm32-vfp-hflt",
        sha256 = "40285dd2d6f8562be9296bb0ef505ca2b1e655ed07248ade110d46cff8ec28de",
        jmodPlatform = "linux-arm",
        termuxArch = "arm",
        glibcPackages = mapOf(
            "glibc-2.44-0" to "29a2580243674498bb7fb56a66590a599924d2599a7b50d88f6d1b1fc918bf06",
            "zlib-glibc-1.3.2-0" to "f0489608b9ae7249c72df983b8ed5ee61d9ef0052e5d3398eca139275d1485a0",
            "gcc-libs-glibc-14.2.1-1" to "5b253b412651218f7478de4b747d8f851dc9609e1f218246d841e44caa81613a"
        ),
        loader = "ld-linux-armhf.so.3"
    ),
    "x86_64" to EmbeddedJvm(
        platform = "linux-amd64",
        sha256 = "b76a06e75c1910e96eeb32232a14e260b1d374b9433b7e9e3525a65b70cde731",
        jmodPlatform = "linux-amd64",
        termuxArch = "x86_64",
        glibcPackages = mapOf(
            "glibc-2.44-0" to "b0bca2eb75d84b14a752df801b3ea40cb60ccb17410d33657a257b0f72e7e470",
            "zlib-glibc-1.3.2-0" to "aea6ba84be3801808bd5bd06fddf6e304ceaea75a5e73d5248bf99406b0b88bb",
            "gcc-libs-glibc-14.2.1-1" to "5f7fd3600a4ac83357c91cd30641eae488c9afc1e2549e62429cafa4d0badf5a"
        ),
        loader = "ld-linux-x86-64.so.2"
    )
)

fun abiTaskName(abi: String) = abi.replace("-", "").replace("_", "").replaceFirstChar(Char::uppercase)

val ndkStripTool = androidComponents.sdkComponents.ndkDirectory.map { ndk ->
    val bin = ndk.dir("toolchains/llvm/prebuilt").asFile.listFiles()!!.single().resolve("bin")
    ndk.file(bin.listFiles()!!.single { it.nameWithoutExtension == "llvm-strip" }
        .relativeTo(ndk.asFile).invariantSeparatorsPath)
}

val prepareGlibcTasks = embeddedJvms.mapValues { (targetAbi, build) ->
    tasks.register<PrepareGlibcTask>("prepareGlibc${abiTaskName(targetAbi)}") {
        packages.set(build.glibcUrls)
        libraryDirectory.set("data/data/com.termux/files/usr/glibc/lib")
        libraries.set(listOf("libc.so.6", "libm.so.6", "libdl.so.2", "libpthread.so.0", "librt.so.1",
            "libz.so.1", "libgcc_s.so.1", "libstdc++.so.6"))
        loader.set(build.loader)
        abi.set(targetAbi)
        loaderLibraryName.set("libglibc_loader.so")
        downloadCache.set(embeddedJvmDownloads)
        runtimeFiles.set(layout.buildDirectory.dir("intermediates/embeddedJvm/glibc/$targetAbi"))
        nativeLibraries.set(layout.buildDirectory.dir("intermediates/embeddedJvm/loader/$targetAbi"))
    }
}

/**
 * The modules patching can reach: what the patcher and its libraries use, plus what ART offers patches
 * beyond that, so a patch that runs inside the app also runs in the JVM.
 */
val embeddedJvmModules = listOf(
    "java.base", "java.logging", "java.xml", "java.sql", "jdk.unsupported", "jdk.charsets",
    // GC collection time used to fail runs whose heap is too small.
    "java.management",
    // Apktool decodes nine-patch PNGs using Raster, BufferedImage and ImageIO.
    "java.desktop"
)

/**
 * Keep the launcher, server VM, native module dependencies, and configuration.
 */
val embeddedJvmFiles = listOf(
    "bin/java", "lib/libjli.so", "lib/server/libjvm.so",
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
        targetPlatform.set(build.jmodPlatform)
        modules.set(embeddedJvmModules)
        runtimeFiles.set(embeddedJvmFiles)
        additionalFiles.from(prepareGlibcTasks.getValue(abi).flatMap { it.runtimeFiles })
        stripTool.set(ndkStripTool)
        jdk.set(javaToolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(25)) })
        downloadCache.set(embeddedJvmDownloads)
        outputArchive.set(layout.buildDirectory.file("intermediates/embeddedJvm/$abi.zip.xz"))
        outputImage.set(layout.buildDirectory.file("intermediates/embeddedJvm/$abi.modules"))
    }
}

/** Assets the embedded JVM runs from, read by JvmInstallation. */
val embeddedJvmAssets = tasks.register<EmbeddedJvmAssetsTask>("embeddedJvmAssets") {
    group = "build"
    description = "Lays out the embedded JVM runtimes and the patcher host as assets."
    runtimes.from(embeddedJvmTasks.map { it.flatMap { task -> task.outputArchive } })
    images.from(embeddedJvmTasks.map { it.flatMap { task -> task.outputImage } })
    baseAbi.set("arm64-v8a")
    runtimeDirectory.set(jvmArchiveDirectory)
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
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    ndkVersion = "25.2.9519653"
    defaultConfig {
        applicationId = "app.universal.patch.manager.support.runtime"
        minSdk = 26
        targetSdk = 36
        versionCode = runtimeVersion.getProperty("versionCode").toInt()
        versionName = runtimeVersion.getProperty("versionName")
        manifestPlaceholders["runtimeUpstreamVersion"] = "Liberica JRE $libericaVersion"
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
