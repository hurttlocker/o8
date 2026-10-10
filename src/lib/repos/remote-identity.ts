/** Compare repository addresses across Git's HTTPS and SSH forms, without credentials. */
export function remoteRepositoryIdentity(value: string | null | undefined): string {
  const input = value?.trim() ?? '';
  if (!input) return '';
  const trimPath = (pathname: string) => pathname.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '');
  const identity = (host: string, pathname: string, sshUser?: string, relativeSshPath = false) => {
    const name = trimPath(pathname);
    const sharedGitAccount = sshUser === 'git' && ['github.com', 'gitlab.com', 'bitbucket.org'].includes(host.toLowerCase());
    // On an arbitrary SSH host, a relative path belongs to the remote user's
    // home. Keep that account in the identity unless addressing is known shared.
    if (sshUser !== undefined && !sharedGitAccount) return `ssh:${sshUser || '(default)'}@${host.toLowerCase()}/${relativeSshPath ? '~' : '/'}${name}`;
    return `${host.toLowerCase()}/${host.toLowerCase() === 'github.com' ? name.toLowerCase() : name}`;
  };
  try {
    const url = new URL(input);
    if (['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) {
      const standardPort = { 'https:': '443', 'http:': '80', 'ssh:': '22', 'git:': '9418' }[url.protocol];
      return identity(`${url.hostname}${url.port && url.port !== standardPort ? `:${url.port}` : ''}`, url.pathname, url.protocol === 'ssh:' ? url.username : undefined);
    }
    if (url.protocol === 'file:') return `local:${decodeURIComponent(url.pathname).replace(/\/+$/, '')}`;
  } catch { /* Git also accepts scp-style SSH addresses and local paths. */ }
  const ssh = input.match(/^(?:([\w.-]+)@)?([\w.-]+):([^\s]+)$/);
  if (ssh && !/^[A-Za-z]:[\\/]/.test(input)) return identity(ssh[2], ssh[3], ssh[1] ?? '', !ssh[3].startsWith('/'));
  return `local:${input.replace(/\/+$/, '')}`;
}
