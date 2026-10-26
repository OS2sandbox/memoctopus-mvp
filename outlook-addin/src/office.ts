/**
 * The few Office.js and MSAL surfaces the add-in touches, typed by hand.
 *
 * Office.js has to come from Microsoft's CDN (an add-in may not bundle it), and
 * MSAL comes from a pinned CDN build with a subresource-integrity hash, so neither
 * is an npm dependency. These interfaces cover only what the add-in calls.
 */

export interface AsyncResult<T> {
  status: 'succeeded' | 'failed';
  value: T;
  error?: { name: string; message: string; code: number };
}

/** The add-in's own key/value store on the appointment (Mailbox 1.1). */
export interface CustomProperties {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  remove(name: string): void;
  saveAsync(callback: (result: AsyncResult<void>) => void): void;
}

/** AppointmentCompose.start / .end (Mailbox 1.1). */
export interface ComposeTime {
  getAsync(callback: (result: AsyncResult<Date>) => void): void;
}

export interface OrganizerItem {
  itemType: string;
  start: ComposeTime;
  end: ComposeTime;
  body: {
    getAsync(coercionType: string, callback: (result: AsyncResult<string>) => void): void;
  };
  loadCustomPropertiesAsync(callback: (result: AsyncResult<CustomProperties>) => void): void;
}

export interface OfficeApi {
  onReady(): Promise<{ host: string | null; platform: string | null }>;
  CoercionType: { Html: string; Text: string };
  AsyncResultStatus: { Succeeded: string; Failed: string };
  context: {
    mailbox: { item: OrganizerItem | null };
    requirements: { isSetSupported(name: string, minVersion?: string): boolean };
  };
}

export function getOffice(): OfficeApi | undefined {
  return (globalThis as { Office?: OfficeApi }).Office;
}

// --- MSAL (UMD build, global `msal`) ---------------------------------------

export interface MsalAccount {
  username?: string;
  tenantId?: string;
}

export interface MsalAuthResult {
  accessToken: string;
}

export interface MsalTokenRequest {
  scopes: string[];
  account?: MsalAccount;
}

export interface MsalNestablePca {
  getActiveAccount(): MsalAccount | null;
  getAllAccounts(): MsalAccount[];
  acquireTokenSilent(request: MsalTokenRequest): Promise<MsalAuthResult>;
  acquireTokenPopup(request: MsalTokenRequest): Promise<MsalAuthResult>;
}

export interface MsalGlobal {
  createNestablePublicClientApplication(config: {
    auth: { clientId: string; authority: string };
  }): Promise<MsalNestablePca>;
}

export function getMsal(): MsalGlobal | undefined {
  return (globalThis as { msal?: MsalGlobal }).msal;
}
