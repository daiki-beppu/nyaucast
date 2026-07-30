import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  bunExecutablePath,
  installProductionPackage,
  installedDependencies,
  instrumentDependencyProbe,
  instrumentRuntimeMarkers,
  isWithinDirectory,
  nodeExecutablePath,
  readJsonRecord,
  removeDependencyAndCreateAncestorFixture,
  replaceDependencyExportsWithInvalidShape,
  replaceDependencyExportsWithIneligibleTargets,
  replaceInstalledDependenciesWithInvalidShape,
  requireFailedSubprocess,
  requireString,
  requireSuccessfulSubprocess,
  runInstalledDependencyProbe,
  runInstalledShim,
  runtimeMarkerEnvironment,
  sourceDependencies,
  withTemporaryDirectory,
} from "./package-smoke-support";

setDefaultTimeout(180_000);

describe("production package smoke", () => {
  test("[REQ-116-01] should install unchanged production dependencies and import every direct dependency when packed for a consumer (TC-116-01)", () => {
    withTemporaryDirectory((directory) => {
      const installed = installProductionPackage(directory);
      const dependencies = installedDependencies(installed);

      expect(Object.keys(dependencies).length).toBeGreaterThan(0);
      expect(dependencies).toEqual(sourceDependencies());
      for (const version of Object.values(dependencies)) {
        expect(version.startsWith("file:")).toBeFalse();
      }

      instrumentDependencyProbe(installed);
      const markerPath = join(directory, "dependency-marker.json");
      const outcome = runInstalledDependencyProbe(installed, markerPath);
      requireSuccessfulSubprocess(
        "installed dependency imports",
        outcome.result
      );
      if (outcome.probes === null) {
        throw new Error("Installed dependency imports returned no probes");
      }

      expect(outcome.probes).toHaveLength(Object.keys(dependencies).length);
      expect(
        outcome.probes.map(({ dependency }) => dependency).toSorted()
      ).toEqual(Object.keys(dependencies).toSorted());
      for (const probe of outcome.probes) {
        expect(
          isWithinDirectory(installed.consumerRoot, probe.packageRoot)
        ).toBeTrue();
        expect(
          isWithinDirectory(installed.consumerRoot, probe.resolvedPath)
        ).toBeTrue();
      }
      expect(
        outcome.probes.some(({ exportKey }) => exportKey === ".")
      ).toBeTrue();
      const fallbackProbe = outcome.probes.find(
        ({ exportKey }) => exportKey !== "."
      );
      if (fallbackProbe === undefined) {
        throw new Error(
          "The production dependencies must exercise a concrete export fallback"
        );
      }

      replaceDependencyExportsWithIneligibleTargets(fallbackProbe);
      const ineligible = runInstalledDependencyProbe(
        installed,
        join(directory, "ineligible-marker.json")
      );
      requireFailedSubprocess(
        `dependency without executable export ${fallbackProbe.dependency}`,
        ineligible.result
      );
      expect(ineligible.probes).toBeNull();
      expect(ineligible.result.stderr).toContain(fallbackProbe.dependency);
      expect(ineligible.result.signal).toBeNull();
      expect(() => {
        requireSuccessfulSubprocess(
          "ineligible export smoke verification",
          ineligible.result
        );
      }).toThrow();

      replaceDependencyExportsWithInvalidShape(fallbackProbe);
      const invalidExports = runInstalledDependencyProbe(
        installed,
        join(directory, "invalid-exports-marker.json")
      );
      requireFailedSubprocess(
        `dependency with invalid exports ${fallbackProbe.dependency}`,
        invalidExports.result
      );
      expect(invalidExports.result.stderr).toContain(
        `${fallbackProbe.dependency} exports must be an object`
      );

      replaceInstalledDependenciesWithInvalidShape(installed);
      const invalidDependencies = runInstalledDependencyProbe(
        installed,
        join(directory, "invalid-dependencies-marker.json")
      );
      requireFailedSubprocess(
        "package with invalid dependencies",
        invalidDependencies.result
      );
      expect(invalidDependencies.result.stderr).toContain(
        "installed dependencies must be an object"
      );
    });
  });

  test("[REQ-116-02] should execute the installed Node launcher and entrypoint with real runtimes when the production shim runs (TC-116-02)", () => {
    withTemporaryDirectory((directory) => {
      const installed = installProductionPackage(directory);
      const unchanged = runInstalledShim(installed, {});
      requireSuccessfulSubprocess("unchanged installed tayk shim", unchanged);
      expect(unchanged.status).toBe(0);
      expect(unchanged.signal).toBeNull();

      const launcherPath = join(installed.packageDirectory, "bin", "tayk.js");
      const launcherMarkerPath = join(directory, "launcher-marker.json");
      const entrypointMarkerPath = join(directory, "entrypoint-marker.json");
      instrumentRuntimeMarkers(
        installed,
        launcherMarkerPath,
        entrypointMarkerPath
      );
      const instrumented = runInstalledShim(
        installed,
        runtimeMarkerEnvironment(launcherMarkerPath, entrypointMarkerPath)
      );

      requireSuccessfulSubprocess(
        "instrumented installed tayk shim",
        instrumented
      );
      expect(instrumented.status).toBe(0);
      expect(instrumented.signal).toBeNull();
      const launcherMarker = readJsonRecord(launcherMarkerPath);
      const entrypointMarker = readJsonRecord(entrypointMarkerPath);
      expect(
        realpathSync(
          requireString(launcherMarker["executable"], "launcher executable")
        )
      ).toBe(nodeExecutablePath);
      expect(
        realpathSync(requireString(launcherMarker["script"], "launcher script"))
      ).toBe(realpathSync(launcherPath));
      expect(
        realpathSync(
          requireString(entrypointMarker["executable"], "entrypoint executable")
        )
      ).toBe(bunExecutablePath);
      expect(
        realpathSync(
          requireString(entrypointMarker["script"], "entrypoint script")
        )
      ).toBe(realpathSync(installed.entrypointPath));
    });
  });

  test("[REQ-116-04] should fail the smoke verification with the entrypoint error when the installed entrypoint is broken (TC-116-04)", () => {
    withTemporaryDirectory((directory) => {
      const installed = installProductionPackage(directory);
      const healthy = runInstalledShim(installed, {});
      requireSuccessfulSubprocess("healthy installed tayk shim", healthy);

      const failureMarker = "REQ_116_04_BROKEN_ENTRYPOINT";
      writeFileSync(
        installed.entrypointPath,
        `throw new Error(${JSON.stringify(failureMarker)});\n`
      );
      const broken = runInstalledShim(installed, {});

      requireFailedSubprocess("broken installed tayk shim", broken);
      expect(broken.status).not.toBe(0);
      expect(broken.signal).toBeNull();
      expect(broken.stderr).toContain(failureMarker);
      expect(() => {
        requireSuccessfulSubprocess("entrypoint smoke verification", broken);
      }).toThrow();
    });
  });

  test("[REQ-116-05] should fail the smoke verification when one resolved direct dependency is missing (TC-116-05)", () => {
    withTemporaryDirectory((directory) => {
      const installed = installProductionPackage(directory);
      instrumentDependencyProbe(installed);
      const markerPath = join(directory, "dependency-marker.json");
      const healthy = runInstalledDependencyProbe(installed, markerPath);
      requireSuccessfulSubprocess(
        "healthy installed dependency imports",
        healthy.result
      );
      const target = healthy.probes?.[0];
      if (target === undefined) {
        throw new Error("At least one direct runtime dependency is required");
      }
      if (!isWithinDirectory(installed.consumerRoot, target.packageRoot)) {
        throw new Error(
          `Refusing to remove dependency outside consumer: ${target.packageRoot}`
        );
      }

      removeDependencyAndCreateAncestorFixture(directory, target);
      const missing = runInstalledDependencyProbe(installed, markerPath);

      requireFailedSubprocess(
        `installed shim with missing dependency ${target.dependency}`,
        missing.result
      );
      expect(missing.probes).toBeNull();
      expect(existsSync(markerPath)).toBeFalse();
      expect(missing.result.status).not.toBe(0);
      expect(missing.result.signal).toBeNull();
      expect(missing.result.stderr).toContain(target.dependency);
      expect(readFileSync(installed.entrypointPath, "utf-8")).toContain(
        "../dependency-probe.ts"
      );
      expect(() => {
        requireSuccessfulSubprocess(
          "dependency smoke verification",
          missing.result
        );
      }).toThrow();
    });
  });
});
