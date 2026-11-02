/**
 * Event handlers for the TEST add-in (manifest-test.xml). Loaded by commands.html
 * in Outlook on the web, new Outlook and Mac, and directly as commands.js in
 * classic Outlook on Windows, which has no DOM: nothing here may touch the page
 * at load.
 */

import { runSendProbe } from './send-probe';

type Associate = (name: string, handler: (event: never) => void) => void;
const office = (globalThis as { Office?: { actions?: { associate?: Associate } } }).Office;

// The name must match FunctionName on the manifest's LaunchEvent.
office?.actions?.associate?.('onAppointmentSendProbe', (event) => {
  void runSendProbe(office as never, event);
});
