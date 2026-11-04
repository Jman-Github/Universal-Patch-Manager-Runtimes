package app.universal.patch.manager.reseam.runtime

import app.reseam.sdk.PatchPhase
import app.reseam.sdk.PatchRef
import app.reseam.sdk.PatchStatus
import app.reseam.sdk.RunEvent
import org.junit.Assert.*
import org.junit.Test

class ReseamProgressTest {
    private class Recorder : ReseamRuntimeCallback {
        val events = mutableListOf<Map<String, Any?>>()
        override fun event(value: Map<String, Any?>) { events += value }
        override fun log(level: String, message: String) {}
        override fun isCancelled() = false
    }

    private fun ref(str: String) = if ('/' in str) PatchRef(str.substringBefore('/'), str.substringAfter('/')) else PatchRef("", str)

    @Test fun patchRefWithoutBundleResolvesReferenceDirectly() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("single_id"), listOf("Single"), false, recorder)
        progress.start()
        progress.invoke(RunEvent.PatchStarted(PatchRef("", "single_id")))
        progress.invoke(RunEvent.PatchFinished(PatchRef("", "single_id"), PatchStatus.Applied))
        progress.beforePublish()
        progress.published()
        assertNull(progress.terminalFailure)
        assertEquals(listOf("single_id"), progress.statuses.filterValues { it is PatchStatus.Applied }.keys.toList())
    }

    @Test fun unselectedCatalogSkipsDoNotFailPatching() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a"), listOf("Readable name"), false, recorder)
        progress.start()
        progress.invoke(RunEvent.PatchFinished(ref("b/unselected"), PatchStatus.Skipped("not selected")))
        progress.invoke(RunEvent.PatchFinished(ref("b/hidden"), PatchStatus.Applied))
        progress.invoke(RunEvent.PatchStarted(ref("b/a")))
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Applied))
        progress.invoke(RunEvent.PatchFinished(ref("b/another"), PatchStatus.Skipped("not selected")))
        progress.beforePublish()
        progress.published()
        assertNull(progress.terminalFailure)
        assertFalse(recorder.events.any { it["type"] == "Failed" })
        val execution = recorder.events.first { it["subSteps"] != null }
        assertEquals(listOf("Readable name"), execution["subSteps"])
        val rows = recorder.events.filter { (it["stepId"] as Map<*, *>)["kind"] == "ExecutePatch" }
        assertEquals(listOf("Started", "Completed"), rows.map { it["type"] })
    }

    @Test fun selectedSkipIsReportedWithoutTerminatingNativeCallback() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a"), listOf("A"), false, recorder)
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Skipped("dependency unavailable")))
        assertEquals("b/a", progress.terminalFailure)
        val failures = recorder.events.filter { it["type"] == "Failed" }
        assertEquals(listOf("ExecutePatch"),
            failures.map { (it["stepId"] as Map<*, *>)["kind"] })
        assertThrows(IllegalStateException::class.java) { progress.beforePublish() }
    }

    @Test fun selectedUnmountablePatchIsReportedWithoutTerminatingNativeCallback() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a"), listOf("A"), false, recorder)
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Unmountable("manifest changed")))
        assertEquals("b/a", progress.terminalFailure)
        val failure = recorder.events.single { it["type"] == "Failed" }
        assertEquals("ExecutePatch", (failure["stepId"] as Map<*, *>)["kind"])
        assertThrows(IllegalStateException::class.java) { progress.beforePublish() }
    }

    @Test fun unselectedUnmountablePatchDoesNotFailRegularInstallation() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a"), listOf("A"), false, recorder)
        progress.invoke(RunEvent.PatchFinished(ref("b/other"), PatchStatus.Unmountable("manifest changed")))
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Applied))
        progress.beforePublish()
        assertNull(progress.terminalFailure)
        assertFalse(recorder.events.any { it["type"] == "Failed" })
    }

    @Test fun revertedPatchesRequireFreshResultsBeforePublication() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a", "b/z"), listOf("A", "Z"), false, recorder)
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Applied))
        progress.invoke(RunEvent.PatchFinished(ref("b/z"), PatchStatus.Applied))
        progress.invoke(RunEvent.PatchesReverted(listOf(ref("b/z"))))
        assertEquals(listOf("b/a"), progress.statuses.filterValues { it is PatchStatus.Applied }.keys.toList())
        assertFalse(progress.statuses.containsKey("b/z"))
        assertNull(progress.terminalFailure)
        assertThrows(IllegalStateException::class.java) { progress.beforePublish() }
        progress.invoke(RunEvent.PatchStarted(ref("b/z")))
        progress.invoke(RunEvent.PatchFinished(ref("b/z"), PatchStatus.Applied))
        progress.beforePublish()
        val firstPatchRows = recorder.events.filter {
            val step = it["stepId"] as Map<*, *>
            step["kind"] == "ExecutePatch" && step["index"] == 0
        }
        assertEquals(listOf("Completed"), firstPatchRows.map { it["type"] })
    }

    @Test fun revertedFailureDoesNotBlockSuccessfulRerun() {
        val progress = ReseamProgress(listOf("b/a"), listOf("A"), false, Recorder())
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Failed("rolled back")))
        assertEquals("b/a", progress.terminalFailure)
        progress.invoke(RunEvent.PatchesReverted(listOf(ref("b/a"))))
        assertNull(progress.terminalFailure)
        assertTrue(progress.statuses.filterValues { it is PatchStatus.Applied }.keys.toList().isEmpty())
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Applied))
        progress.beforePublish()
        assertEquals(listOf("b/a"), progress.statuses.filterValues { it is PatchStatus.Applied }.keys.toList())
    }

    @Test fun dependencyOrderUsesSelectionIndexes() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a", "b/z"), listOf("A", "Z"), false, recorder)
        progress.start()
        progress.invoke(RunEvent.PatchStarted(ref("b/z")))
        progress.invoke(RunEvent.PatchFinished(ref("b/z"), PatchStatus.Applied))
        progress.invoke(RunEvent.PatchFinished(ref("b/hidden"), PatchStatus.Applied))
        progress.invoke(RunEvent.PatchStarted(ref("b/a")))
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Applied))
        progress.beforePublish()
        progress.published()
        val patches = recorder.events.filter { (it["stepId"] as Map<*, *>)["kind"] == "ExecutePatch" }
        assertEquals(listOf(1, 1, 0, 0), patches.map { (it["stepId"] as Map<*, *>)["index"] })
        assertEquals(listOf("Started", "Completed", "Started", "Completed"), patches.map { it["type"] })
        assertEquals("WriteAPK", (recorder.events.last()["stepId"] as Map<*, *>)["kind"])
        assertEquals("Completed", recorder.events.last()["type"])
    }

    @Test fun duplicateResultsDoNotRestartCompletedRows() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a", "b/z"), listOf("A", "Z"), true, recorder)
        progress.invoke(RunEvent.PatchStarted(ref("b/a")))
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Applied))
        progress.invoke(RunEvent.PatchFinished(ref("b/z"), PatchStatus.Failed("failure")))
        val before = recorder.events.size
        assertEquals(listOf("b/a"), progress.statuses.filterValues { it is PatchStatus.Applied }.keys.toList())
        progress.invoke(RunEvent.PatchStarted(ref("b/a")))
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Applied))
        assertEquals(before, recorder.events.size)
        progress.beforePublish()
        assertNull(progress.terminalFailure)
    }

    @Test fun changedResultIsReportedWithoutRestartingRow() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a", "b/z"), listOf("A", "Z"), true, recorder)
        progress.invoke(RunEvent.PatchStarted(ref("b/a")))
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Applied))
        progress.invoke(RunEvent.PatchFinished(ref("b/z"), PatchStatus.Failed("failure")))
        val before = recorder.events.size
        progress.invoke(RunEvent.PatchStarted(ref("b/a")))
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Skipped("dependency unavailable")))
        val changed = recorder.events.drop(before)
        assertEquals(1, changed.size)
        assertEquals("Failed", changed.single()["type"])
        assertEquals(0, (changed.single()["stepId"] as Map<*, *>)["index"])
        assertTrue(progress.statuses.filterValues { it is PatchStatus.Applied }.keys.toList().isEmpty())
        progress.beforePublish()
    }

    @Test fun selectedFailureCannotKillSdkBeforeItUnwinds() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a"), listOf("A"), false, recorder)
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Failed("failure")))
        val failures = recorder.events.filter { it["type"] == "Failed" }
        assertEquals(listOf("ExecutePatch"),
            failures.map { (it["stepId"] as Map<*, *>)["kind"] })
        assertThrows(IllegalStateException::class.java) { progress.beforePublish() }
    }

    @Test fun dependencyFailureStopsNormalPatching() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a"), listOf("A"), false, recorder)
        progress.invoke(RunEvent.PatchFinished(ref("b/hidden"), PatchStatus.Failed("failure")))
        assertEquals("b/hidden", progress.terminalFailure)
        assertFalse(recorder.events.any { it["type"] == "Failed" })
        assertThrows(IllegalStateException::class.java) { progress.beforePublish() }
    }

    @Test fun continueOnErrorPublishesIndependentSuccessAndReportsFailedDependentsOnce() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/failed", "b/dependent", "b/independent"),
            listOf("Failed", "Dependent", "Independent"), true, recorder)
        progress.start()
        progress.invoke(RunEvent.PatchStarted(ref("b/failed")))
        progress.invoke(RunEvent.PatchFinished(ref("b/failed"), PatchStatus.Failed("failure")))
        progress.invoke(RunEvent.PatchFinished(ref("b/dependent"), PatchStatus.Skipped("dependency failed")))
        progress.invoke(RunEvent.PatchStarted(ref("b/independent")))
        progress.invoke(RunEvent.PatchFinished(ref("b/independent"), PatchStatus.Applied))
        val before = recorder.events.size
        progress.statuses.toMap().forEach { (reference, status) -> progress.finishPatch(reference, status) }
        assertEquals(before, recorder.events.size)
        progress.beforePublish()
        assertNull(progress.terminalFailure)
        val failures = recorder.events.filter { it["type"] == "Failed" }
        assertEquals(listOf(0, 1), failures.map { (it["stepId"] as Map<*, *>)["index"] })
        assertEquals(PatchStatus.Applied, progress.statuses["b/independent"])
        assertFalse(recorder.events.any {
            it["type"] == "Completed" && (it["stepId"] as Map<*, *>)["kind"] == "WriteAPK"
        })
        progress.published()
        assertEquals("Completed", recorder.events.last()["type"])
    }

    @Test fun sdkPhasesAdvanceStepsWithoutDuplicateStartsOrEarlyPublication() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a"), listOf("A"), false, recorder)
        progress.start()
        val phases = listOf(
            PatchPhase.OPEN_APK to "ReadAPK",
            PatchPhase.LOAD_BUNDLES to "ExecutePatches",
            PatchPhase.VALIDATE_PATCHES to "ExecutePatches",
            PatchPhase.APPLY_PATCHES to "ExecutePatches",
            PatchPhase.WRITE_UNSIGNED_ARTIFACTS to "WriteAPK",
            PatchPhase.LOAD_SIGNING_KEY to "WriteAPK",
            PatchPhase.REWRITE_OUTPUT to "WriteAPK",
            PatchPhase.SIGN_ARTIFACTS to "WriteAPK"
        )
        phases.forEach { (phase, expectedStep) ->
            progress.invoke(RunEvent.PhaseStarted(phase))
            assertEquals(phase.name, expectedStep, progress.activeStep)
        }
        val starts = recorder.events.filter { it["type"] == "Started" }
        assertEquals(listOf("ReadAPK", "ExecutePatches", "WriteAPK"),
            starts.map { (it["stepId"] as Map<*, *>)["kind"] })
        assertFalse(recorder.events.any {
            it["type"] == "Completed" && (it["stepId"] as Map<*, *>)["kind"] == "WriteAPK"
        })
    }

    @Test fun outputPreparationHasProgressWithoutClaimingPublicationEarly() {
        val recorder = Recorder()
        val progress = ReseamProgress(listOf("b/a"), listOf("A"), false, recorder)
        progress.invoke(RunEvent.PatchFinished(ref("b/a"), PatchStatus.Applied))
        progress.invoke(RunEvent.PhaseStarted(PatchPhase.WRITE_UNSIGNED_ARTIFACTS))
        progress.beforePublish()
        progress.preparingUnsigned(0, 2)
        progress.preparingUnsigned(1, 2)
        progress.preparingUnsigned(2, 2)
        progress.finalizing()
        progress.finalizing(0, 1024)
        progress.finalizing(512, 1024)
        progress.finalizing(1024, 1024)
        val writeEvents = recorder.events.filter { (it["stepId"] as Map<*, *>)["kind"] == "WriteAPK" }
        assertFalse(writeEvents.any { it["type"] == "Completed" })
        val nativeWrite = writeEvents.first { it["message"] == "Writing patched APKs" }
        assertNull(nativeWrite["current"])
        assertNull(nativeWrite["total"])
        val packaging = writeEvents.filter { it["message"] == "Finalizing output" && it["current"] != null }
        assertEquals(listOf(0L, 512L, 1024L), packaging.map { it["current"] })
        val unsigned = writeEvents.filter { it["message"] == "Preparing unsigned APKs" }
        assertEquals(listOf(0L, 1L, 2L), unsigned.map { it["current"] })
        assertTrue(unsigned.all { it["total"] == 2L })
        progress.published()
        assertEquals("Completed", recorder.events.last()["type"])
    }

    @Test(expected = IllegalStateException::class)
    fun missingCompletionCannotPublish() {
        ReseamProgress(listOf("b/a"), listOf("A"), true, Recorder()).beforePublish()
    }
}
