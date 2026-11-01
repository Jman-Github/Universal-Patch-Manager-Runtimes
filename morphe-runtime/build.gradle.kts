import java.util.Properties
import kotlin.random.Random
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.parcelize)
}
val runtimeVersion = Properties().apply { project.file("version.properties").inputStream().use(::load) }


val jvmHost by configurations.creating
val copyJvmHost = tasks.register<PluginJvmHostTask>("copyJvmHost") {
    hostJars.from(jvmHost)
    outputDirectory.set(layout.buildDirectory.dir("generated/jvmHost"))
}

android {
    namespace = "app.universal.patch.manager.morphe.runtime"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "app.universal.patch.manager.morphe.runtime"
        minSdk = 26
        targetSdk = 36
        versionCode = runtimeVersion.getProperty("versionCode").toInt()
        versionName = runtimeVersion.getProperty("versionName")
        manifestPlaceholders["runtimeUpstreamVersion"] = project.extensions.getByType<org.gradle.api.artifacts.VersionCatalogsExtension>().named("libs").findVersion("morphe-patcher").get().requiredVersion
    }

    val keystoreFile = rootProject.file("keystore.jks")
    val keystorePassword = System.getenv("KEYSTORE_PASSWORD")
    val keystoreEntryAlias = System.getenv("KEYSTORE_ENTRY_ALIAS")
    val keystoreEntryPassword = System.getenv("KEYSTORE_ENTRY_PASSWORD")
    val hasReleaseSigningCredentials = keystoreFile.exists() &&
        !keystorePassword.isNullOrBlank() &&
        !keystoreEntryAlias.isNullOrBlank() &&
        !keystoreEntryPassword.isNullOrBlank()
    val signAsDebug = project.hasProperty("signAsDebug")
    if (System.getenv("CI").toBoolean() && !signAsDebug && !hasReleaseSigningCredentials) {
        throw GradleException(
            "Release signing credentials are required in CI. Set KEYSTORE_PASSWORD, " +
                "KEYSTORE_ENTRY_ALIAS, and KEYSTORE_ENTRY_PASSWORD, or pass -PsignAsDebug for debug signing."
        )
    }
    val releaseSigningConfig = if (signAsDebug || !hasReleaseSigningCredentials) {
        signingConfigs.getByName("debug")
    } else {
        signingConfigs.maybeCreate("release").apply {
            storeFile = keystoreFile
            storePassword = keystorePassword
            keyAlias = keystoreEntryAlias
            keyPassword = keystoreEntryPassword
        }
    }

    buildTypes {
        debug {
            buildConfigField("long", "BUILD_ID", "${Random.nextLong()}L")
            signingConfig = releaseSigningConfig
        }
        release {
            buildConfigField("long", "BUILD_ID", "0L")
            signingConfig = releaseSigningConfig
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }

    sourceSets.getByName("main").kotlin.directories.add(rootProject.file("shared/merger/src/main/java").path)
    // Share the resource sampler with the host so both process modes report the same metrics.
    sourceSets.named("main") {
        kotlin.directories += "../host-support/src/main/java/app/universal/patch/manager/patcher/runtime/usage"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        aidl = true
        buildConfig = true
    }
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

usePatcherClassMergerCompatibility()

dependencies {
    jvmHost(project(":upm-patcher-core", "hostJar"))
    implementation(libs.arsclib)
    implementation(libs.morphe.patcher) {
        exclude(group = "xmlpull", module = "xmlpull")
        exclude(group = "xpp3", module = "xpp3")
        exclude(group = "com.github.REAndroid", module = "arsclib")
    }
    implementation(libs.morphe.library) {
        exclude(group = "xmlpull", module = "xmlpull")
        exclude(group = "xpp3", module = "xpp3")
        exclude(group = "com.github.REAndroid", module = "arsclib")
    }
    implementation("com.android.tools.build:apkzlib:8.5.2")
    compileOnly("com.google.guava:guava:33.2.1-jre")
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    implementation(libs.kotlinx.coroutines.android)
    compileOnly(libs.hidden.api.stub)
}

tasks.matching { it.name.startsWith("compile") && it.name.endsWith("Aidl") }.configureEach {
    doLast {
        val generatedRoot = layout.buildDirectory.dir("generated/aidl_source_output_dir").get().asFile
        if (!generatedRoot.exists()) return@doLast
        generatedRoot.walkTopDown()
            .filter { it.isFile && it.extension == "java" }
            .forEach { file ->
                val original = file.readText()
                val sanitized = original.lineSequence().joinToString(separator = "\n") { line ->
                    if (line.startsWith(" * Using: ")) line.replace('\\', '/')
                    else line
                }
                if (sanitized != original) {
                    file.writeText(sanitized)
                }
            }
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyJvmHost, PluginJvmHostTask::outputDirectory)
        variant.outputs.forEach { it.outputFileName.set("morphe-plugin.apk") }
    }
}
