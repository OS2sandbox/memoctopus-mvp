// The role/group catalogue refresh's HTTP mapping (see refresh-http.ts), shared by the cron route and
// the admin button.
import type { NextResponse } from 'next/server';
import type { CatalogueRefreshResult } from './catalogue-sync';
import { refreshResultResponse } from './refresh-http';
import { catalogueErrorMessage } from './labels.da';

export const catalogueResultResponse = (result: CatalogueRefreshResult, friendly: boolean): NextResponse =>
  refreshResultResponse(result, friendly, catalogueErrorMessage);
