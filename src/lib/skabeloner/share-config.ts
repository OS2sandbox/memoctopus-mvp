// Whether the admin has enabled sharing a skabelon as a copy/paste code. The code
// is self-contained (no server storage), so it is on by default.
export interface ShareConfig {
  code: boolean;
}

export function getShareConfig(): ShareConfig {
  return {
    code: process.env.SKABELON_SHARE_CODE !== 'false',
  };
}
