import { vi } from "vitest";

// The CTAN package store as the page sees it. Everything resolves instantly and
// nothing touches the network; tests tweak the mocks per case.
export const ctan = {
  ensureDefaults: vi.fn(async (_progress?: (n: string, d: number, t: number) => void): Promise<string[]> => []),
  installWithDependencies: vi.fn(async (name: string) => ({
    package: { name },
    installedDependencies: [] as string[],
    unresolved: [] as string[],
  })),
  packageForFile: vi.fn(async (_b: string): Promise<string | null> => null),
  searchPackages: vi.fn(async (_q: string, _n?: number) => [] as { name: string; installed: boolean; shortdesc: string }[]),
  remotePackageNames: vi.fn(async () => [] as string[]),
  storeFiles: vi.fn(async () => []),
  listPackages: vi.fn(async () => []),
  removePackage: vi.fn(async () => {}),
};

export function resetCtan(): void {
  ctan.ensureDefaults.mockReset().mockResolvedValue([]);
  ctan.installWithDependencies.mockReset().mockImplementation(async (name: string) => ({
    package: { name },
    installedDependencies: [],
    unresolved: [],
  }));
  ctan.packageForFile.mockReset().mockResolvedValue(null);
  ctan.searchPackages.mockReset().mockResolvedValue([]);
  ctan.remotePackageNames.mockReset().mockResolvedValue([]);
  ctan.storeFiles.mockReset().mockResolvedValue([]);
}
