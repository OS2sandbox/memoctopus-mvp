/**
 * Function commands for the TEST add-in (manifest-test.xml), loaded by
 * commands.html: the meeting-provider button that stands in for Outlook's Teams
 * toggle. Nothing here may touch the page at load.
 */

import type { OfficeApi, ProviderItem } from './office';
import { insertMeeting } from './provider';

type Associate = (name: string, handler: (event: { completed(): void }) => void) => void;
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
    event.completed();
    return;
  }
  void insertMeeting(office, item).finally(() => event.completed());
});
