import type {
  ModsResponse,
  ModVersionsRecord,
  ModVersionsResponse,
} from '@civmods/parser';
import { fetch } from '@tauri-apps/plugin-http';
import * as fs from '@tauri-apps/plugin-fs';
// import { parseContentDisposition } from '../../../../packages/parser/src/headers';
import { invoke } from '@tauri-apps/api/core';
import * as path from '@tauri-apps/api/path';
import { ModData, ModInfo } from '../home/IModInfo';
import { useAppStore } from '../store/store';
import { getModFolderPath } from './commands/getModFolderPath';
import { getActiveModsFolder } from './getModsFolder';
import {
  invokeBackupModToTemp,
  invokeCleanupModBackup,
  invokeRestoreModFromTemp,
} from './commands/modsRustBindings';

function parseContentDisposition(contentDisposition: string | null): {
  filename?: string;
  extension?: string;
} {
  if (!contentDisposition) return {};

  const match = contentDisposition.match(
    /filename\*?=(?:UTF-8'')?([^;\r\n]*)/i
  );
  if (match && match[1]) {
    let filename = decodeURIComponent(match[1].replace(/['"]/g, '')); // Remove quotes
    let extension = filename.includes('.')
      ? filename.split('.').pop()
      : undefined;
    return { filename, extension };
  }

  return {};
}

export interface InstallModOptions {
  modsFolderPath: string | null;
}

/**
 * Converts a Google Drive file URL into a direct download link.
 * @param url - The original Google Drive file URL
 * @returns Direct download URL or null if invalid
 */
function getGoogleDriveDirectDownloadUrl(url: string): string | null {
  const match = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (match && match[1]) {
    return `https://drive.google.com/uc?export=download&id=${match[1]}`;
  }
  return null;
}

export function isModLocked(mod: ModInfo) {
  const lockedModIds = new Set(useAppStore.getState().lockedModIds ?? []);
  return lockedModIds.has(mod.modinfo_id ?? '');
}

/**
 * Installs a specific version of a Mod.
 * Handles automatically the update (removal of previous version) if needed
 */
export async function installMod(mod: ModData, version: ModVersionsRecord) {
  if (!version?.download_url) {
    throw new Error(`Mod ${mod.name} v: ${version?.name} has no download URL`);
  }

  const modsFolder = await getActiveModsFolder();

  // Allow to restore mod if installation fails
  let backupPath: string | null = null;

  try {
    if (!modsFolder) {
      throw new Error('Mods folder not set');
    }

    if (mod.local != null) {
      if (isModLocked(mod.local)) {
        throw new Error('Mod is locked');
      }

      const modPath = await getModFolderPath(modsFolder!, mod.local);
      backupPath = await invokeBackupModToTemp(modPath);

      await uninstallMod(mod.local);
    }

    await runLowLevelInstallMod(version, { modsFolderPath: modsFolder });

    // This is a delicate moment where mod is installed and backup would be restored
    // if something goes wrong. If we reach this point, we _Need_ to cleanup the backup.
    // We already do it in the finally block, but in case we'll add other operations
    // we need to make sure that cleanup is called before.
    if (backupPath) await invokeCleanupModBackup(backupPath);
  } catch (error) {
    console.error('Failed to install mod:', error, error instanceof Error && error.stack); // prettier-ignore
    if (backupPath && modsFolder) {
      try {
        await invokeRestoreModFromTemp(modsFolder, backupPath);
        console.log(`Restored mod backup from`, backupPath);
      } catch (error) {
        // Already failed, no need to throw another error
        console.error('HIGH: Failed to restore mod:', error);
      }
    }
    throw error;
  } finally {
    if (backupPath) {
      await invokeCleanupModBackup(backupPath);
    }
  }
}

/**
 * This should be called only internally, as it doesn't check if the mod is locked,
 * nor implements backups.
 */
export async function runLowLevelInstallMod(
  mod: ModVersionsRecord,
  options: InstallModOptions
) {
  if (!mod.download_url) {
    throw new Error(`Mod ${mod.id} has no download URL`);
  }

  if (!options.modsFolderPath) {
    throw new Error('No mods folder provided. Please set it in the settings.');
  }

  console.log('Downloading mod from:', mod.download_url);
  let response = await fetch(mod.download_url);
  if (!response.ok) {
    throw new Error(`Failed to download mod: ${response.statusText}`);
  }
  if (!response.url) {
    console.error(
      `Headers of failed download:`,
      JSON.stringify(Object.fromEntries(response.headers.entries()))
    );
    throw new Error('Failed to download mod: no URL provided');
  }

  console.log('Downloaded mod:', response.url);

  if (response.redirected) console.log('Redirected to:', response.url);

  if (
    response.url.includes('//drive.google.com/') &&
    !response.url.includes('export')
  ) {
    console.log('Redirected to Google Drive, getting direct download link..');
    const updatedUrl = getGoogleDriveDirectDownloadUrl(response.url);
    if (!updatedUrl) {
      console.warn(`Failed to get direct download link for ${response.url}`);
      throw new Error(
        'Failed to download mod: redirect link provider is not supported'
      );
    }

    response = await fetch(updatedUrl);
    if (!response.ok)
      throw new Error(
        `Failed to download Google Drive link. Please download it manually. ${updatedUrl}`
      );
  }

  const contentDisposition = response.headers.get('content-disposition');
  console.log('Downloaded mod:', contentDisposition);
  const { filename, extension } = parseContentDisposition(contentDisposition);

  if (!filename || !extension) {
    throw new Error('Failed to parse filename or extension');
  }
  console.log('Filename:', filename, 'Extension:', extension);
  const modsFolderPath = options.modsFolderPath;

  console.log('Mods folder:', modsFolderPath);
  const tempArchivePath = await path.join(
    modsFolderPath,
    `${mod.id}_${filename}`
  );

  console.log('Saving mod to:', tempArchivePath);
  const buffer = await response.arrayBuffer();

  console.log('Writing mod archive to disk..');
  const extractPath = await path.join(
    modsFolderPath,
    `civmods-${mod.modinfo_id ?? mod.mod_id}-${mod.cf_id}`
  );

  try {
    await fs.writeFile(tempArchivePath, new Uint8Array(buffer));

    console.log('Extracting mod to:', extractPath);
    const result = await invoke<string>('extract_mod_archive', {
      archivePath: tempArchivePath,
      extractTo: extractPath,
    });

    console.log('Mod installed!', result);
  } catch (error) {
    console.error('Failed to install mod:', error);
    if (await fs.exists(extractPath)) {
      console.log('Removing failed mod:', extractPath);
      await fs.remove(extractPath, { recursive: true });
    }
    throw error;
  } finally {
    console.log('Removing temp archive:', tempArchivePath);
    await fs.remove(tempArchivePath);
  }
}

/**
 * Uninstall mod
 */
export async function uninstallMod(modInfo: ModInfo) {
  const modsFolderPath = await getActiveModsFolder();
  if (!modsFolderPath) {
    throw new Error('No mods folder provided. Please set it in the settings.');
  }

  const lockedModIds = new Set(useAppStore.getState().lockedModIds ?? []);
  if (lockedModIds.has(modInfo.modinfo_id ?? '')) {
    console.warn('Skipping locked mod:', modInfo.mod_name, modInfo.modinfo_id);
    return;
  }

  console.log('Mods folder:', modsFolderPath);
  const modPath = await getModFolderPath(modsFolderPath, modInfo);

  if (!(await fs.exists(modPath))) {
    console.warn('Mod not found:', modPath);
    return;
  }

  console.log('Removing mod:', modPath);
  await fs.remove(modPath, { recursive: true });
}

export function canInstallMod(mod: ModVersionsRecord): boolean {
  return mod.download_url != null && !mod.skip_install;
}
