// The user/organisation sync's HTTP mapping (see refresh-http.ts), shared by the cron route and the
// admin button.
import type { NextResponse } from 'next/server';
import { syncErrorMessage } from './labels.da';
import { refreshResultResponse } from './refresh-http';
import type { SyncResult } from './types';

export const syncResultResponse = (result: SyncResult, friendly: boolean): NextResponse =>
  refreshResultResponse(result, friendly, syncErrorMessage);
