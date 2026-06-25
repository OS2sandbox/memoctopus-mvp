// Which skabelon sharing methods the server admin has enabled, controlled by env
// so a deployment can offer either, both, or neither.
//
// - code: a self-contained copy/paste code; needs no server storage, so it is on
//   by default.
// - link: a server-stored token + import link; requires the shared_skabeloner
//   table, so it is opt-in (off by default).
export interface ShareConfig {
  code: boolean;
  link: boolean;
}

export function getShareConfig(): ShareConfig {
  return {
    code: process.env.SKABELON_SHARE_CODE !== 'false',
    link: process.env.SKABELON_SHARE_LINK === 'true',
  };
}
