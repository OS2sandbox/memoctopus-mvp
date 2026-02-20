import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/api/proxy";

function buildPath(path: string[] | undefined) {
  const subPath = path?.join("/") || "";
  return `/api/history${subPath ? `/${subPath}` : ""}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const { path } = await params;
  return proxyToBackend(request, buildPath(path));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const { path } = await params;
  return proxyToBackend(request, buildPath(path));
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const { path } = await params;
  return proxyToBackend(request, buildPath(path));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const { path } = await params;
  return proxyToBackend(request, buildPath(path));
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const { path } = await params;
  return proxyToBackend(request, buildPath(path));
}
