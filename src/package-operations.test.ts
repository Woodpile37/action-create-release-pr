import fs from 'fs';
import cloneDeep from 'lodash.clonedeep';
import * as actionUtils from '@metamask/action-utils/dist/file-utils';
import {
  ManifestDependencyFieldNames,
  ManifestFieldNames,
} from '@metamask/action-utils';
import * as autoChangelog from '@metamask/auto-changelog';
import * as gitOps from './git-operations';
import {
  getMetadataForAllPackages,
  getPackagesToUpdate,
  updatePackage,
  updatePackages,
} from './package-operations';

jest.mock('fs', () => ({
  promises: {
    lstat: jest.fn(),
    readdir: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
  },
}));

jest.mock('glob', () => {
  return (
    _pattern: string,
    _options: Record<string, unknown>,
    callback: (error: Error | null, results: string[]) => unknown,
  ) => {
    callback(null, [
      'packages/dir1',
      'packages/dir2',
      'packages/dir3',
      'packages/someFile',
    ]);
  };
});

jest.mock('@metamask/action-utils/dist/file-utils', () => {
  const actualModule = jest.requireActual(
    '@metamask/action-utils/dist/file-utils',
  );
  return {
    ...actualModule,
    readJsonObjectFile: jest.fn(),
  };
});

jest.mock('@metamask/auto-changelog', () => {
  return {
    updateChangelog: jest.fn(),
  };
});

jest.mock('./git-operations', () => {
  const actualModule = jest.requireActual('./git-operations');
  return {
    ...actualModule,
    didPackageChange: jest.fn(),
  };
});

jest.mock('./utils', () => {
  const actualModule = jest.requireActual('./utils');
  return {
    ...actualModule,
    WORKSPACE_ROOT: 'root',
  };
});

const MOCK_PACKAGES_DIR = 'packages';

type DependencyFieldsDict = Partial<
  Record<ManifestDependencyFieldNames, Record<string, string>>
>;

// Convenience method to match behavior of utils.writeJsonFile
const jsonStringify = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const getMockManifest = (
  name: string,
  version: string,
  dependencyFields: DependencyFieldsDict = {},
) => {
  return { name, version, ...dependencyFields };
};

describe('package-operations', () => {
  describe('getMetadataForAllPackages', () => {
    const names = ['name1', 'name2', 'name3'];
    const dirs = ['dir1', 'dir2', 'dir3'];
    const version = '1.0.0';
    const SOME_FILE = 'someFile';

    const getMockPackageMetadata = (index: number) => {
      return {
        dirName: dirs[index],
        manifest: getMockManifest(names[index], version),
        [ManifestFieldNames.Name]: names[index],
        dirPath: `${MOCK_PACKAGES_DIR}/${dirs[index]}`,
      };
    };

    function getMockReadJsonFile() {
      let mockIndex = -1;
      return async () => {
        mockIndex += 1;
        return getMockManifest(names[mockIndex], version);
      };
    }

    beforeEach(() => {
      jest.spyOn(fs.promises, 'lstat').mockImplementation((async (
        path: string,
      ) => {
        return path.endsWith(SOME_FILE)
          ? { isDirectory: () => false }
          : { isDirectory: () => true };
      }) as any);

      jest
        .spyOn(actionUtils, 'readJsonObjectFile')
        .mockImplementation(getMockReadJsonFile());
    });

    it('does not throw', async () => {
      expect(await getMetadataForAllPackages(['packages/*'])).toStrictEqual({
        [names[0]]: getMockPackageMetadata(0),
        [names[1]]: getMockPackageMetadata(1),
        [names[2]]: getMockPackageMetadata(2),
      });
    });
  });

  describe('getPackagesToUpdate', () => {
    let didPackageChangeMock: jest.SpyInstance;

    const packageNames = ['name1', 'name2', 'name3'];

    const mockMetadataRecord = {
      [packageNames[0]]: {},
      [packageNames[1]]: {},
      [packageNames[2]]: {},
    };

    beforeEach(() => {
      didPackageChangeMock = jest.spyOn(gitOps, 'didPackageChange');
    });

    it('returns all packages if synchronizeVersions is true', async () => {
      expect(
        await getPackagesToUpdate(mockMetadataRecord as any, true, new Set()),
      ).toStrictEqual(new Set(packageNames));
      expect(didPackageChangeMock).not.toHaveBeenCalled();
    });

    it('returns changed packages if synchronizeVersions is false', async () => {
      didPackageChangeMock
        .mockImplementationOnce(async () => false)
        .mockImplementationOnce(async () => true)
        .mockImplementationOnce(async () => false);

      expect(
        await getPackagesToUpdate(mockMetadataRecord as any, false, new Set()),
      ).toStrictEqual(new Set([packageNames[1]]));
      expect(didPackageChangeMock).toHaveBeenCalledTimes(3);
    });

    it('throws an error if there are no packages to update', async () => {
      didPackageChangeMock.mockImplementation(async () => false);

      await expect(
        getPackagesToUpdate(mockMetadataRecord as any, false, new Set()),
      ).rejects.toThrow(/no packages to update/u);
      expect(didPackageChangeMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('Updating packages', () => {
    const writeFileMock = jest
      .spyOn(fs.promises, 'writeFile')
      .mockImplementation(() => Promise.resolve());
    const readFileMock = jest.spyOn(fs.promises, 'readFile');

    const updateChangelogMock = jest.spyOn(autoChangelog, 'updateChangelog');

    const getMockPackageMetadata = (
      dirPath: string,
      manifest: ReturnType<typeof getMockManifest>,
    ) => {
      return {
        dirPath,
        manifest,
      };
    };

    const getMockWritePath = (dirPath: string) =>
      `root/${dirPath}/package.json`;

    const mockDirs = ['dir1', 'dir2', 'dir3'];
    const packageNames = ['name1', 'name2', 'name3'];

    describe('updatePackage (singular)', () => {
      it('updates a package without dependencies', async () => {
        const originalVersion = '1.0.0';
        const newVersion = '1.0.1';
        const dir = mockDirs[0];
        const name = packageNames[0];
        const manifest = getMockManifest(name, originalVersion);

        const packageMetadata = getMockPackageMetadata(dir, manifest);
        const updateSpecification = {
          newVersion,
          packagesToUpdate: new Set(packageNames),
          repositoryUrl: '',
          shouldUpdateChangelog: false,
          synchronizeVersions: false,
        };

        await updatePackage(packageMetadata, updateSpecification);
        expect(writeFileMock).toHaveBeenCalledTimes(1);
        expect(writeFileMock).toHaveBeenCalledWith(
          getMockWritePath(dir),
          jsonStringify({
            ...cloneDeep(manifest),
            [ManifestFieldNames.Version]: newVersion,
          }),
        );
        expect(updateChangelogMock).not.toHaveBeenCalled();
      });

      it('updates a package and its changelog', async () => {
        const originalVersion = '1.0.0';
        const newVersion = '1.0.1';
        const dir = mockDirs[0];
        const name = packageNames[0];
        const manifest = getMockManifest(name, originalVersion);

        const repoUrl = 'https://fake';
        const changelogContent = 'I am a changelog.';
        readFileMock.mockImplementationOnce(async () => changelogContent);

        const packageMetadata = getMockPackageMetadata(dir, manifest);
        const updateSpecification = {
          newVersion,
          packagesToUpdate: new Set(packageNames),
          repositoryUrl: repoUrl,
          shouldUpdateChangelog: true,
          synchronizeVersions: false,
        };

        await updatePackage(packageMetadata, updateSpecification);
        expect(writeFileMock).toHaveBeenCalledTimes(1);
        expect(writeFileMock).toHaveBeenCalledWith(
          getMockWritePath(dir),
          jsonStringify({
            ...cloneDeep(manifest),
            [ManifestFieldNames.Version]: newVersion,
          }),
        );
        expect(updateChangelogMock).toHaveBeenCalledTimes(1);
        expect(updateChangelogMock).toHaveBeenCalledWith({
          changelogContent,
          currentVersion: newVersion,
          isReleaseCandidate: true,
          projectRootDirectory: dir,
          repoUrl,
        });
      });

      it('re-throws changelog read error', async () => {
        const originalVersion = '1.0.0';
        const newVersion = '1.0.1';
        const dir = mockDirs[0];
        const name = packageNames[0];
        const manifest = getMockManifest(name, originalVersion);

        readFileMock.mockImplementationOnce(async () => {
          throw new Error('readError');
        });

        const packageMetadata = getMockPackageMetadata(dir, manifest);
        const updateSpecification = {
          newVersion,
          packagesToUpdate: new Set(packageNames),
          repositoryUrl: 'https://fake',
          shouldUpdateChangelog: true,
          synchronizeVersions: false,
        };

        const consoleErrorSpy = jest
          .spyOn(console, 'error')
          .mockImplementationOnce(() => undefined);

        await expect(
          updatePackage(packageMetadata, updateSpecification),
        ).rejects.toThrow(new Error('readError'));
        expect(updateChangelogMock).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringMatching(/^Failed to read changelog/u),
        );
      });

      it('updates a package without synchronizing dependency versions', async () => {
        const originalVersion = '1.0.0';
        const newVersion = '1.0.1';
        const dir = mockDirs[0];
        const name = packageNames[0];
        const manifest = getMockManifest(name, originalVersion, {
          dependencies: { foo: 'bar', [packageNames[1]]: originalVersion },
        });

        const packageMetadata = getMockPackageMetadata(dir, manifest);
        const updateSpecification = {
          newVersion,
          packagesToUpdate: new Set(packageNames),
          synchronizeVersions: false,
          repositoryUrl: '',
          shouldUpdateChangelog: false,
        };

        await updatePackage(packageMetadata, updateSpecification);
        expect(writeFileMock).toHaveBeenCalledTimes(1);
        expect(writeFileMock).toHaveBeenCalledWith(
          getMockWritePath(dir),
          jsonStringify({
            ...cloneDeep(manifest),
            [ManifestFieldNames.Version]: newVersion,
          }),
        );
        expect(updateChangelogMock).not.toHaveBeenCalled();
      });

      it('updates a package and synchronizes dependency versions', async () => {
        const originalVersion = '1.0.0';
        const newVersion = '1.0.1';
        const dir = mockDirs[0];
        const name = packageNames[0];

        const originalDependencies = {
          dependencies: {
            foo: 'bar',
            [packageNames[1]]: `^${originalVersion}`,
          },
          devDependencies: { [packageNames[2]]: `^${originalVersion}` },
        };
        const expectedDependencies = {
          dependencies: { foo: 'bar', [packageNames[1]]: `^${newVersion}` },
          devDependencies: { [packageNames[2]]: `^${newVersion}` },
        };

        const manifest = getMockManifest(
          name,
          originalVersion,
          originalDependencies,
        );

        const packageMetadata = getMockPackageMetadata(dir, manifest);
        const updateSpecification = {
          newVersion,
          packagesToUpdate: new Set(packageNames),
          synchronizeVersions: true,
          repositoryUrl: '',
          shouldUpdateChangelog: false,
        };

        await updatePackage(packageMetadata, updateSpecification);
        expect(writeFileMock).toHaveBeenCalledTimes(1);
        expect(writeFileMock).toHaveBeenCalledWith(
          getMockWritePath(dir),
          jsonStringify(
            getMockManifest(name, newVersion, expectedDependencies),
          ),
        );
        expect(updateChangelogMock).not.toHaveBeenCalled();
      });
    });

    // This method just calls updatePackage in a loop.
    describe('updatePackages (plural)', () => {
      it('updates multiple packages', async () => {
        const originalVersion = '1.0.0';
        const newVersion = '1.0.1';
        const dir1 = mockDirs[0];
        const dir2 = mockDirs[1];
        const name1 = packageNames[0];
        const name2 = packageNames[1];
        const manifest1 = getMockManifest(name1, originalVersion);
        const manifest2 = getMockManifest(name2, originalVersion);

        const packageMetadata1 = getMockPackageMetadata(dir1, manifest1);
        const packageMetadata2 = getMockPackageMetadata(dir2, manifest2);

        const allPackages = {
          [name1]: packageMetadata1,
          [name2]: packageMetadata2,
        };
        const updateSpecification = {
          newVersion,
          packagesToUpdate: new Set([name1, name2]),
          synchronizeVersions: false,
          repositoryUrl: '',
          shouldUpdateChangelog: false,
        };

        await updatePackages(allPackages, updateSpecification);
        expect(writeFileMock).toHaveBeenCalledTimes(2);
        expect(writeFileMock).toHaveBeenNthCalledWith(
          1,
          getMockWritePath(dir1),
          jsonStringify({
            ...cloneDeep(manifest1),
            [ManifestFieldNames.Version]: newVersion,
          }),
        );
        expect(writeFileMock).toHaveBeenNthCalledWith(
          2,
          getMockWritePath(dir2),
          jsonStringify({
            ...cloneDeep(manifest2),
            [ManifestFieldNames.Version]: newVersion,
          }),
        );
      });
    });
  });
});
