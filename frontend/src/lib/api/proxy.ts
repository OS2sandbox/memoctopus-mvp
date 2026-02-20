import { type NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env["BACKEND_URL"] || "http://localhost:8002";

export async function proxyToBackend(
  request: NextRequest,
  backendPath: string,
) {
  const url = `${BACKEND_URL}${backendPath}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "host") {
      headers.set(key, value);
    }
  });

  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error - duplex is required for streaming body
      duplex: "half",
    });

    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      responseHeaders.set(key, value);
    });

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Proxy error:", error);
    return NextResponse.json(
      { error: "Failed to proxy request to backend" },
      { status: 502 },
    );
  }
}
