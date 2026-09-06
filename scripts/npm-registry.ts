export async function npmLatestVersion(name: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
  if (!res.ok) throw new Error(`npm registry returned ${res.status} for ${name}@latest`);
  const body = (await res.json()) as { version: string };
  return body.version;
}
