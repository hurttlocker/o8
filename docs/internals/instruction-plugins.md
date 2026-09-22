# Instruction plugins and skill creation

Customize > Skills can create a skill or import one Markdown file. A save writes
`.agents/skills/<name>/SKILL.md` in the selected registered repository or the
personal home folder. Existing names are never overwritten. Import accepts name
and description frontmatter plus instructions; supporting files are not copied.

The development Plugins page manages real local instruction bundles. Its first
catalog entry is Project guide. The page supports review, install, update,
disable, enable, and confirmed removal. Installed state survives reopening the
page. Other Customize sections remain separate.

## Bundle format

```json
{
  "format": "o8-instructions-v1",
  "id": "project-guide",
  "name": "Project guide",
  "version": "1.0.0",
  "description": "Reusable project guidance",
  "skills": [
    {
      "name": "project-orientation",
      "description": "Understand a repository before editing",
      "instructions": "Read the repository instructions and identify relevant checks."
    }
  ]
}
```

The format accepts 1 to 12 skills, unique lowercase hyphenated names, and a
three-part numeric version. Updates retain the package id and require a newer
version. Unknown properties are rejected, including hooks, scripts, commands,
connections, and external file references. Import is a local file operation;
there is no remote download, package-manager execution, or account connection.
Imported metadata is not a verified publisher identity.

## Storage and consumption

Managed packages live in the resolved o8 data directory. Repository libraries
are keyed by the canonical repository path, outside the repository itself.
Each package has an atomically published installation record and immutable
revision directories. Reads validate the manifest hash and Markdown contents.
A SQLite transaction serializes mutations and releases its lock if the process
exits. An interrupted unpublished update can be retried without replacing the
active version first. Damaged packages are excluded from the usable inventory and
can be removed through an explicit recovery action. Removal deletes only that
package's managed directory. If physical cleanup fails after removal from the
library, the response reports pending cleanup instead of claiming a failed removal.

Enabled contributions appear in the skill inventory. Use in task reads the
selected skill through an authenticated route and inserts its instruction text
into the existing unsent composer draft. It does not teach the agent to read a
private data path, send a prompt, or grant new permissions. Automatic discovery
of ordinary skill folders still depends on the runtime. Supporting files are
not attached by this flow.

Disabling hides the package's skills from future inventory and Use in task
reads. It cannot withdraw instructions already copied into a task. A skill
saved independently from the plugin remains independent when the plugin is
removed.

## Current boundary

This is an instruction-bundle installer, not a general executable plugin host.
Connected-service plugins, external marketplace sources, native runtime plugin
translation, and account authorization remain separate work. The development
UI gate does not make those capabilities available.
