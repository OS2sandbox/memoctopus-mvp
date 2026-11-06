/**
 * The add-in's function command, loaded by commands.html (the manifest's
 * FunctionFile): the "Teams-møde med referat" menu command (provider.ts).
 * Nothing here may touch the page at load.
 */

import type { OfficeApi, ProviderItem } from './office';
import { insertMeeting } from './provider';

/** `allowEvent: false` tells Outlook the command did not do its job (a provider toggle flips back off). */
type CommandEvent = { completed(options?: { allowEvent?: boolean }): void };
type Associate = (name: string, handler: (event: CommandEvent) => void) => void;
const office = (globalThis as {
  Office?: OfficeApi & { actions?: { associate?: Associate } };
}).Office;

console.info('[os2taletiltekst] commands.js loaded; Office.actions:', Boolean(office?.actions));

// As in Microsoft's own command pages: tell Office the page is up.
void office?.onReady?.();

// The name must match FunctionName on the manifest's ExecuteFunction action.
office?.actions?.associate?.('insertOs2Meeting', (event) => {
  const item = office.context.mailbox.item as ProviderItem | null;
  if (!item) {
    event.completed({ allowEvent: false });
    return;
  }
  insertMeeting(office, item)
    .then((outcome) => event.completed({ allowEvent: outcome === 'armed' || outcome === 'already_ours' }))
    .catch(() => event.completed({ allowEvent: false }));
});
