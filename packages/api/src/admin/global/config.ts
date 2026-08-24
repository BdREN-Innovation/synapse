import { BASE_CONFIG_PRINCIPAL_ID, logger } from '@librechat/data-schemas';
import { PrincipalModel, PrincipalType } from 'librechat-data-provider';
import type { IConfig, RecordAuditEntryInput } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { buildAuditContext } from '../context';
import {
  encryptConfigSecrets,
  encryptConfigSecretFields,
  getConfigSecretInputError,
  getConfigSecretMutationPaths,
  isConfigSecretDescendantPath,
  preserveConfigSecrets,
  redactConfigSecrets,
} from '../secrets';
import { getTopLevelSection, isValidFieldPath } from '../config';

const DEFAULT_PRIORITY = 10;
const MAX_PATCH_ENTRIES = 100;

export interface GlobalConfigDeps {
  findConfigByPrincipal: (
    principalType: PrincipalType,
    principalId: string,
    options?: { includeInactive?: boolean },
  ) => Promise<IConfig | null>;
  upsertConfig: (
    principalType: PrincipalType,
    principalId: string,
    principalModel: PrincipalModel,
    overrides: Partial<TCustomConfig>,
    priority: number,
  ) => Promise<IConfig | null>;
  patchConfigFields: (
    principalType: PrincipalType,
    principalId: string,
    principalModel: PrincipalModel,
    fields: Record<string, unknown>,
    priority: number,
  ) => Promise<IConfig | null>;
  unsetConfigField: (
    principalType: PrincipalType,
    principalId: string,
    fieldPath: string,
  ) => Promise<IConfig | null>;
  deleteConfig: (
    principalType: PrincipalType,
    principalId: string,
  ) => Promise<IConfig | null>;
  getAppConfig?: (options?: { baseOnly?: boolean }) => Promise<Record<string, unknown>>;
  invalidateConfigCaches?: () => Promise<void>;
  recordAuditEntry?: (
    input: RecordAuditEntryInput,
    options?: { failClosed?: boolean },
  ) => Promise<unknown>;
}

type Caller = { id: string; name: string };

function caller(req: ServerRequest): Caller | null {
  if (!req.user) return null;
  const id = req.user._id?.toString() ?? req.user.id;
  if (!id) return null;
  return { id, name: req.user.name || req.user.username || req.user.email || id };
}

function safeConfig(config: IConfig | null): IConfig | null {
  if (!config) return null;
  const copy = JSON.parse(JSON.stringify(config)) as IConfig;
  redactConfigSecrets(copy.overrides);
  return copy;
}

function versionOf(config: IConfig | null): number {
  return config?.configVersion ?? 0;
}

function sections(config: IConfig | null): string {
  return Object.keys(config?.overrides ?? {}).join(',').slice(0, 500);
}

function expectedVersion(body: Record<string, unknown>): number | null {
  return typeof body.expectedVersion === 'number' && Number.isInteger(body.expectedVersion)
    ? body.expectedVersion
    : null;
}

export function createGlobalConfigHandlers(deps: GlobalConfigDeps): {
  read: (req: ServerRequest, res: Response) => Promise<Response>;
  replace: (req: ServerRequest, res: Response) => Promise<Response>;
  patch: (req: ServerRequest, res: Response) => Promise<Response>;
  resetField: (req: ServerRequest, res: Response) => Promise<Response>;
  reset: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const base = () =>
    deps.findConfigByPrincipal(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, {
      includeInactive: true,
    });

  async function audit(req: ServerRequest, action: RecordAuditEntryInput['action'], before: IConfig | null, after: IConfig | null, operation: string) {
    const actor = caller(req);
    if (!actor || !deps.recordAuditEntry) return;
    await deps.recordAuditEntry(
      {
        action,
        actor: { type: 'user', id: actor.id, name: actor.name },
        target: { type: 'config', id: 'global_config', name: 'Global configuration' },
        context: buildAuditContext(req),
        metadata: {
          operation,
          sections: sections(after ?? before),
          beforeVersion: versionOf(before),
          afterVersion: versionOf(after),
          before: JSON.stringify(safeConfig(before)?.overrides ?? {}).slice(0, 2000),
          after: JSON.stringify(safeConfig(after)?.overrides ?? {}).slice(0, 2000),
        },
      },
      { failClosed: true },
    );
  }

  async function checkVersion(req: ServerRequest, res: Response, current: IConfig | null): Promise<boolean> {
    const expected = expectedVersion((req.body ?? {}) as Record<string, unknown>);
    if (expected === null) {
      res.status(400).json({ code: 'EXPECTED_VERSION_REQUIRED', error: 'expectedVersion is required' });
      return false;
    }
    if (expected !== versionOf(current)) {
      res.status(409).json({ code: 'CONFIG_VERSION_CONFLICT', error: 'Global configuration changed; reload and retry', configVersion: versionOf(current) });
      return false;
    }
    return true;
  }

  async function read(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const config = await base();
      const appConfig = deps.getAppConfig ? await deps.getAppConfig({ baseOnly: true }) : undefined;
      return res.status(200).json({ config: safeConfig(config), appConfig });
    } catch (error) {
      logger.error('[globalConfig] read failed', error);
      return res.status(500).json({ error: 'Failed to read global config' });
    }
  }

  async function replace(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const body = req.body as { overrides?: Partial<TCustomConfig>; priority?: number };
      if (!body?.overrides || typeof body.overrides !== 'object' || Array.isArray(body.overrides)) return res.status(400).json({ error: 'overrides must be a plain object' });
      const current = await base();
      if (!(await checkVersion(req, res, current))) return res;
      const encrypted = encryptConfigSecrets(body.overrides);
      const after = await deps.upsertConfig(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, PrincipalModel.ROLE, preserveConfigSecrets(encrypted, current?.overrides), body.priority ?? current?.priority ?? DEFAULT_PRIORITY);
      await audit(req, req.path.endsWith('/import') ? 'config.global_imported' : 'config.global_replaced', current, after, req.path.endsWith('/import') ? 'import' : 'replace');
      await deps.invalidateConfigCaches?.();
      return res.status(200).json({ config: safeConfig(after) });
    } catch (error) {
      logger.error('[globalConfig] replace failed', error);
      return res.status(500).json({ error: 'Failed to replace global config' });
    }
  }

  async function patch(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const body = req.body as { entries?: Array<{ fieldPath: string; value: unknown }> };
      if (!Array.isArray(body?.entries) || body.entries.length === 0 || body.entries.length > MAX_PATCH_ENTRIES) return res.status(400).json({ error: `entries must contain 1-${MAX_PATCH_ENTRIES} items` });
      const fields: Record<string, unknown> = {};
      for (const entry of body.entries) {
        if (!isValidFieldPath(entry.fieldPath) || isConfigSecretDescendantPath(entry.fieldPath)) return res.status(400).json({ error: `Invalid or protected field path: ${entry.fieldPath}` });
        const secretError = getConfigSecretInputError(entry.fieldPath, entry.value);
        if (secretError) return res.status(400).json({ error: secretError });
        fields[entry.fieldPath] = entry.value;
      }
      const current = await base();
      if (!(await checkVersion(req, res, current))) return res;
      const after = await deps.patchConfigFields(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, PrincipalModel.ROLE, encryptConfigSecretFields(fields), current?.priority ?? DEFAULT_PRIORITY);
      await audit(req, 'config.global_patched', current, after, `patch:${Object.keys(fields).map(getTopLevelSection).join(',')}`);
      await deps.invalidateConfigCaches?.();
      return res.status(200).json({ config: safeConfig(after) });
    } catch (error) {
      logger.error('[globalConfig] patch failed', error);
      return res.status(500).json({ error: 'Failed to patch global config' });
    }
  }

  async function resetField(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const fieldPath = String((req.query as Record<string, unknown>).fieldPath ?? '');
      if (!isValidFieldPath(fieldPath) || isConfigSecretDescendantPath(fieldPath)) return res.status(400).json({ error: 'Invalid or protected field path' });
      const current = await base();
      if (!(await checkVersion(req, res, current))) return res;
      let after: IConfig | null = current;
      for (const path of getConfigSecretMutationPaths(fieldPath)) after = await deps.unsetConfigField(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, path);
      await audit(req, 'config.global_field_reset', current, after, `reset:${fieldPath}`);
      await deps.invalidateConfigCaches?.();
      return res.status(200).json({ config: safeConfig(after) });
    } catch (error) {
      logger.error('[globalConfig] reset field failed', error);
      return res.status(500).json({ error: 'Failed to reset global field' });
    }
  }

  async function reset(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const current = await base();
      if (!(await checkVersion(req, res, current))) return res;
      const deleted = await deps.deleteConfig(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID);
      await audit(req, 'config.global_reset', current, null, 'reset');
      await deps.invalidateConfigCaches?.();
      return res.status(200).json({ success: true, configVersion: versionOf(deleted) });
    } catch (error) {
      logger.error('[globalConfig] reset failed', error);
      return res.status(500).json({ error: 'Failed to reset global config' });
    }
  }

  return { read, replace, patch, resetField, reset };
}
