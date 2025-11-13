/**
 * CSRF Token Management
 *
 * Handles fetching and caching of CSRF tokens for API requests.
 */

import { authClient } from "@/lib/auth-client";

const API_BASE_URL =
  process.env["NEXT_PUBLIC_API_URL"] || "http://localhost:8000";

let cachedCsrfToken: string | null = null;

/**
 * Fetch CSRF token from the backend.
 * Caches the token for subsequent requests.
 */
export async function getCsrfToken(): Promise<string> {
  // Return cached token if available
  if (cachedCsrfToken) {
    return cachedCsrfToken;
  }

  // Get session token
  const session = await authClient.getSession();
  const sessionToken = session?.data?.session?.token;

  if (!sessionToken) {
    throw new Error("No session token available");
  }

  // Fetch CSRF token from backend
  const response = await fetch(`${API_BASE_URL}/api/csrf-token`, {
    headers: {
      "X-Session-Token": sessionToken,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch CSRF token");
  }

  const data = await response.json();

  if (!data.csrfToken || typeof data.csrfToken !== "string") {
    throw new Error("Invalid CSRF token received from server");
  }

  // Cache and return the token
  const token: string = data.csrfToken;
  cachedCsrfToken = token;

  return token;
}

/**
 * Clear the cached CSRF token.
 * Call this when the user logs out or when a CSRF error occurs.
 */
export function clearCsrfToken(): void {
  cachedCsrfToken = null;
}

/**
 * Get headers with both session and CSRF tokens.
 * Use this for all mutating requests (POST, PUT, DELETE).
 */
export async function getAuthAndCsrfHeaders(): Promise<HeadersInit> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  // Get session token
  const session = await authClient.getSession();
  if (session?.data?.session?.token) {
    headers["X-Session-Token"] = session.data.session.token;
  }

  // Get CSRF token for mutating requests
  try {
    const csrfToken = await getCsrfToken();
    headers["X-CSRF-Token"] = csrfToken;
  } catch (error) {
    console.error("Failed to get CSRF token:", error);
    // Don't throw - let the backend handle the missing token
  }

  return headers;
}
