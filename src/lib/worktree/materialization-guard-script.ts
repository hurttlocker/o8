export const WORKSPACE_IDENTITY_CHECK = String.raw`
const actual = fs.lstatSync('.');
const canonicalPath = fs.realpathSync('.');
if (!actual.isDirectory() || actual.isSymbolicLink()
  || actual.dev !== expected.device || actual.ino !== expected.inode
  || canonicalPath !== expected.canonicalPath) {
  process.stderr.write('Managed workspace ownership changed before process execution.\n');
  process.exit(78);
}
`;
