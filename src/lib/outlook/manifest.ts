/**
 * The Outlook add-in's manifest (add-in-only XML; the unified manifest is not
 * supported on Outlook for Mac or with on-prem mailboxes). An admin uploads it in
 * the Microsoft 365 admin center (Integrated Apps) and assigns it to users.
 *
 * Built from the server's own public URL, so every deployment hands out a
 * manifest that points at itself. The admin center keeps the file it was given,
 * so a change here reaches users only when the admin uploads the new file: bump
 * ADDIN_VERSION whenever the output changes.
 *
 * There is also a TEST variant (`buildManifest(origin, 'test')`, served at
 * /outlook-addin/manifest-test.xml): a separate add-in with its own id, for a
 * developer to sideload, that adds an OnAppointmentSend probe
 * (outlook-addin/src/send-probe.ts). It never replaces the real one.
 */

/** Fixed for the life of the add-in: Outlook and the admin center key it on this. */
export const ADDIN_ID = '3b8720fe-bdc3-4a89-ab8b-f35412c768bd';
export const ADDIN_VERSION = '1.0.0.0';

/** The test add-in's own id, so it can sit next to the real one. */
export const TEST_ADDIN_ID = 'c1d6f0a4-5e2b-4f7a-9b3c-8a2e6d4f1b07';
export const TEST_ADDIN_VERSION = '1.0.0.0';

/** The URL path the add-in's pages are served under (public/outlook-addin/). */
export const ADDIN_PATH = '/outlook-addin';

export type ManifestVariant = 'production' | 'test';

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The button on the organizer's meeting form, at the given indent. */
function commandSurface(indent: string): string {
  return `<ExtensionPoint xsi:type="AppointmentOrganizerCommandSurface">
  <OfficeTab id="TabDefault">
    <Group id="os2taletiltekst.group">
      <Label resid="Group.Label"/>
      <Control xsi:type="Button" id="os2taletiltekst.armButton">
        <Label resid="ArmButton.Label"/>
        <Supertip>
          <Title resid="ArmButton.Label"/>
          <Description resid="ArmButton.Tooltip"/>
        </Supertip>
        <Icon>
          <bt:Image size="16" resid="Icon.16x16"/>
          <bt:Image size="32" resid="Icon.32x32"/>
          <bt:Image size="80" resid="Icon.80x80"/>
        </Icon>
        <Action xsi:type="ShowTaskpane">
          <SourceLocation resid="Taskpane.Url"/>
        </Action>
      </Control>
    </Group>
  </OfficeTab>
</ExtensionPoint>`.replace(/\n/g, `\n${indent}`);
}

/** The Resources block, at the given indent; `extraUrls` are more bt:Url lines. */
function resources(page: (name: string) => string, label: string, indent: string, extraUrls: string[] = []): string {
  return `<Resources>
  <bt:Images>
    <bt:Image id="Icon.16x16" DefaultValue="${page('assets/icon-16.png')}"/>
    <bt:Image id="Icon.32x32" DefaultValue="${page('assets/icon-32.png')}"/>
    <bt:Image id="Icon.80x80" DefaultValue="${page('assets/icon-80.png')}"/>
  </bt:Images>
  <bt:Urls>
    <bt:Url id="Taskpane.Url" DefaultValue="${page('taskpane.html')}"/>${extraUrls.map((u) => `\n    ${u}`).join('')}
  </bt:Urls>
  <bt:ShortStrings>
    <bt:String id="Group.Label" DefaultValue="${label}"/>
    <bt:String id="ArmButton.Label" DefaultValue="${label}"/>
  </bt:ShortStrings>
  <bt:LongStrings>
    <bt:String id="ArmButton.Tooltip" DefaultValue="Slå OS2taletiltekst til for mødet, så der kommer et referat ud af det."/>
  </bt:LongStrings>
</Resources>`.replace(/\n/g, `\n${indent}`);
}

/**
 * The test add-in's VersionOverridesV1_1, nested last in V1_0 as the schema
 * wants: the same button, plus the OnAppointmentSend event (Mailbox 1.12) and the
 * runtime it runs in. commands.html serves web, new Outlook and Mac; classic
 * Outlook on Windows loads commands.js directly (the Override).
 */
function testOverrides(page: (name: string) => string, label: string): string {
  const i = '    ';
  return `
    <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides/1.1" xsi:type="VersionOverridesV1_1">
      <Requirements>
        <bt:Sets DefaultMinVersion="1.12">
          <bt:Set Name="Mailbox"/>
        </bt:Sets>
      </Requirements>
      <Hosts>
        <Host xsi:type="MailHost">
          <Runtimes>
            <Runtime resid="WebViewRuntime.Url">
              <Override type="javascript" resid="JSRuntime.Url"/>
            </Runtime>
          </Runtimes>
          <DesktopFormFactor>
            <FunctionFile resid="WebViewRuntime.Url"/>
            ${commandSurface(`${i}        `)}
            <ExtensionPoint xsi:type="LaunchEvent">
              <LaunchEvents>
                <LaunchEvent Type="OnAppointmentSend" FunctionName="onAppointmentSendProbe" SendMode="PromptUser"/>
              </LaunchEvents>
              <SourceLocation resid="WebViewRuntime.Url"/>
            </ExtensionPoint>
          </DesktopFormFactor>
        </Host>
      </Hosts>
      ${resources(page, label, `${i}  `, [
        `<bt:Url id="WebViewRuntime.Url" DefaultValue="${page('commands.html')}"/>`,
        `<bt:Url id="JSRuntime.Url" DefaultValue="${page('commands.js')}"/>`,
      ])}
    </VersionOverrides>`;
}

/**
 * `origin` must be the https origin the add-in is served from, e.g.
 * https://taletiltekst.syddjurs.dk. Throws on anything else: Outlook loads
 * add-ins over https only, and a path or query would end up in every URL.
 */
export function buildManifest(origin: string, variant: ManifestVariant = 'production'): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`The add-in needs a bare https origin, got ${origin}`);
  }
  const base = xmlEscape(url.origin);
  const page = (name: string) => `${base}${ADDIN_PATH}/${name}`;
  const test = variant === 'test';
  const label = test ? 'OS2taletiltekst (test)' : 'OS2taletiltekst';
  const generatedBy = test ? 'manifest-test.xml' : 'manifest.xml';
  const testNote = test
    ? `
  TEST add-in: sideload it for yourself only. On Send it shows what it could
  see (Teams link, silent sign-in) and lets you send anyway. It arms nothing.`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  OS2taletiltekst for Outlook. Generated by ${base}${ADDIN_PATH}/${generatedBy}.
  Permissions: ReadItem, the lowest level that covers it: reading the meeting's
  text and its own per-meeting note (custom properties). Sign-in is nested app
  authentication, which needs no manifest permission.${testNote}
-->
<OfficeApp
  xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xmlns:mailappor="http://schemas.microsoft.com/office/mailappversionoverrides/1.0"
  xsi:type="MailApp">
  <Id>${test ? TEST_ADDIN_ID : ADDIN_ID}</Id>
  <Version>${test ? TEST_ADDIN_VERSION : ADDIN_VERSION}</Version>
  <ProviderName>OS2taletiltekst</ProviderName>
  <DefaultLocale>da-DK</DefaultLocale>
  <DisplayName DefaultValue="${label}"/>
  <Description DefaultValue="Slår OS2taletiltekst til for et Teams-møde, så der kommer et referat ud af mødet."/>
  <IconUrl DefaultValue="${page('assets/icon-64.png')}"/>
  <HighResolutionIconUrl DefaultValue="${page('assets/icon-128.png')}"/>
  <SupportUrl DefaultValue="${base}/"/>
  <AppDomains>
    <AppDomain>${base}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Mailbox"/>
  </Hosts>
  <Requirements>
    <Sets>
      <Set Name="Mailbox" MinVersion="1.3"/>
    </Sets>
  </Requirements>
  <FormSettings>
    <Form xsi:type="ItemEdit">
      <DesktopSettings>
        <SourceLocation DefaultValue="${page('taskpane.html')}"/>
      </DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Appointment" FormType="Edit"/>
  </Rule>
  <DisableEntityHighlighting>false</DisableEntityHighlighting>

  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Requirements>
      <bt:Sets DefaultMinVersion="1.3">
        <bt:Set Name="Mailbox"/>
      </bt:Sets>
    </Requirements>
    <Hosts>
      <Host xsi:type="MailHost">
        <DesktopFormFactor>
          ${commandSurface('          ')}
        </DesktopFormFactor>
      </Host>
    </Hosts>
    ${resources(page, label, '    ')}${test ? testOverrides(page, label) : ''}
  </VersionOverrides>
</OfficeApp>
`;
}
