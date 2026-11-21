/*
 * Copyright 2026 Morphe.
 * https://github.com/MorpheApp/morphe-manager
 */

// Code adapted from Morphe, see third-party/NOTICE for more information.
// https://github.com/MorpheApp/morphe-manager/pull/1215
// https://github.com/MorpheApp/morphe-manager/pull/1474

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ArchiveOperations
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Nested
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.jvm.toolchain.JavaLauncher
import org.gradle.process.ExecOperations
import org.tukaani.xz.ARM64Options
import org.tukaani.xz.ARMOptions
import org.tukaani.xz.FilterOptions
import org.tukaani.xz.X86Options
import java.io.File
import java.util.zip.GZIPInputStream
import javax.inject.Inject

/**
 * Turns a Linux build of the JVM into the runtime the app ships for one ABI: the modules the
 * patcher needs linked into a new image, next to the native libraries and configuration of the
 * build, packed into one archive for the app's assets, see [writeXzArchive]. The image is left out
 * of the archive, as [EmbeddedJvmAssetsTask] ships the images of all ABIs as one.
 *
 * The build ships every module of the JDK, most of which patching never touches. Its classes are
 * relinked rather than replaced with those of another JDK, as an Android build carries changes of
 * its own in them.
 */
@CacheableTask
abstract class PrepareEmbeddedJvmTask : DefaultTask() {
    @get:Input
    abstract val url: Property<String>

    @get:Input
    abstract val sha256: Property<String>

    /** The platform the modules are linked for, as jmod names it, such as linux-aarch64. */
    @get:Input
    abstract val targetPlatform: Property<String>

    /** Modules of the image. Whatever they require is linked in with them. */
    @get:Input
    abstract val modules: ListProperty<String>

    /** Files and directories taken from the build as they are, relative to its root. */
    @get:Input
    abstract val runtimeFiles: ListProperty<String>

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val additionalFiles: ConfigurableFileCollection

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val stripTool: RegularFileProperty

    /** The JDK whose tools link the image, which has to be of the same feature release. */
    @get:Nested
    abstract val jdk: Property<JavaLauncher>

    /** Where downloaded builds are kept between builds, as they rarely change. */
    @get:Internal
    abstract val downloadCache: DirectoryProperty

    @get:OutputFile
    abstract val outputArchive: RegularFileProperty

    /** The linked image, lib/modules of the runtime. */
    @get:OutputFile
    abstract val outputImage: RegularFileProperty

    @get:Inject
    abstract val archives: ArchiveOperations

    @get:Inject
    abstract val fileSystem: FileSystemOperations

    @get:Inject
    abstract val exec: ExecOperations

    @TaskAction
    fun prepare() {
        val work = temporaryDir.apply {
            deleteRecursively()
            mkdirs()
        }
        val jdkBin = jdk.get().metadata.installationPath.asFile.resolve("bin")
        fun tool(name: String) = jdkBin.resolve(name).takeIf { it.exists() }?.path ?: jdkBin.resolve("$name.exe").path

        val build = unpack(downloadPinned(url.get(), sha256.get(), downloadCache.get().asFile, logger), work)

        // The modules as classes and resources, with the module graph and lambda forms the build's
        // own link generated, which a new link generates again
        val exploded = work.resolve("exploded")
        run(tool("jimage"), "extract", "--dir", exploded.path, build.resolve("lib/modules").path)
        exploded.resolve("java.base/jdk/internal/module")
            .listFiles { file -> file.name.startsWith("SystemModules$") }
            ?.forEach(File::delete)

        // java.base carries the hashes of the modules tied to it, which no longer match once they
        // are packed again, so they are recorded anew as java.base itself is packed last
        val jmods = work.resolve("jmods").apply { mkdirs() }
        exploded.listFiles()!!.filter { it.name != JAVA_BASE }.forEach { module ->
            run(tool("jmod"), "create", "--class-path", module.path, jmods.resolve("${module.name}.jmod").path)
        }
        run(
            tool("jmod"), "create",
            "--class-path", exploded.resolve(JAVA_BASE).path,
            "--target-platform", targetPlatform.get(),
            "--module-path", jmods.path,
            // Without * or ?, which the JDK's launchers on Windows expand as file names
            "--hash-modules", "(java|jdk)\\..+",
            jmods.resolve("$JAVA_BASE.jmod").path
        )

        val linked = work.resolve("linked")
        run(
            tool("jlink"),
            "--module-path", jmods.path,
            "--add-modules", modules.get().joinToString(","),
            "--disable-plugin", "generate-jli-classes",
            "--strip-debug",
            "--no-header-files",
            "--no-man-pages",
            "--output", linked.path
        )

        // The license notices of every module the link took in, which the GPL has go with the binaries
        val legal = linkedModules(linked.resolve("release")).map { "legal/$it" }

        linked.resolve(IMAGE_PATH).copyTo(outputImage.get().asFile, overwrite = true)

        val image = work.resolve("image")
        fileSystem.copy {
            from(linked) { include("release") }
            from(build) { (runtimeFiles.get() + legal).forEach { include(it, "$it/**") } }
            from(additionalFiles)
            into(image)
        }
        check(image.resolve("bin/java").isFile && image.resolve("lib/server/libjvm.so").isFile) {
            "Missing JVM launcher or server VM for ${targetPlatform.get()}"
        }
        image.walkTopDown().filter { it.isFile && it.isElf() }.forEach {
            run(stripTool.get().asFile.path, "--strip-all", it.path)
        }
        writeXzArchive(
            outputArchive.get().asFile,
            image.walkTopDown().filter { it.isFile }.map { file ->
                file.relativeTo(image).invariantSeparatorsPath to { file.readBytes() }
            },
            bcjFor(targetPlatform.get())
        )
    }

    // The native libraries take up most of the archive. For 32-bit ARM, the ARM converter packs
    // the build tighter than the Thumb one.
    private fun bcjFor(platform: String): FilterOptions = when (platform.substringAfter('-')) {
        "aarch64" -> ARM64Options()
        "arm" -> ARMOptions()
        "amd64" -> X86Options()
        else -> throw GradleException("No branch converter for $platform")
    }

    private fun unpack(archive: File, work: File): File {
        val destination = work.resolve("build")
        val tar = work.resolve("build.tar")
        try {
            GZIPInputStream(archive.inputStream().buffered()).use { input ->
                tar.outputStream().use { input.copyTo(it) }
            }
            fileSystem.copy {
                from(archives.tarTree(tar))
                into(destination)
            }
        } finally {
            tar.delete()
        }
        return destination.listFiles()?.singleOrNull()?.takeIf { it.isDirectory }
            ?: destination
    }

    // The modules jlink resolved, required ones included, as it lists them in the image's release file
    private fun linkedModules(release: File): List<String> =
        release.readLines()
            .firstOrNull { it.startsWith(RELEASE_MODULES) }
            ?.removePrefix(RELEASE_MODULES)
            ?.trim('"')
            ?.split(' ')
            ?.filter { it.isNotBlank() }
            ?: throw GradleException("$release lists no modules")

    private fun run(vararg command: String) {
        exec.exec { commandLine(*command) }
    }

    private fun File.isElf() =
        inputStream().use { it.readNBytes(ELF_MAGIC.size) }.contentEquals(ELF_MAGIC)

    private companion object {
        const val JAVA_BASE = "java.base"
        const val RELEASE_MODULES = "MODULES="
        const val IMAGE_PATH = "lib/modules"
        val ELF_MAGIC = byteArrayOf(0x7f, 0x45, 0x4c, 0x46)
    }
}
