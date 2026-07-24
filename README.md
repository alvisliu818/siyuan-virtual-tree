# Virtual Document Tree

A SiYuan Note plugin that builds a virtual document tree panel based on document first-block link relations.

Unlike the traditional document tree organized by notebook physical hierarchy, this plugin builds a virtual relationship tree by parsing the **reference links in each document's first block**, letting you browse and organize content by reference relationships rather than being constrained by the notebook's native hierarchy.

## Features

- **Virtual tree construction**: Builds parent-child hierarchy from document first-block references; supports duplicate document names (disambiguated by document ID)
- **Multiple root-adding entry points**: Add/remove root documents via the document tree context menu, editor title context menu, or command palette
- **Focus current document**: One-click to show only the descendant tree of the currently active document for focused browsing
- **Locate current document**: Quickly scroll to the currently active document within the virtual tree
- **Physical subtree merge (optional)**: Optionally include documents' physical children from SiYuan's native hierarchy as virtual child nodes
- **Multiple sort methods**: By name, by custom weight attribute, or by custom drag-and-drop order
- **Auto-refresh**: Listens to ws events and automatically rebuilds the tree after document add/delete/update/move
- **Multi-tab support**: Correctly identifies the currently active document in multi-tab environments
- **Hover tooltip**: Mouse hover shows document name + ID, plus the `notebook > parent document` physical path
- **Persistent collapse state**: Collapse/expand state is preserved across sessions
- **Configurable limits**: Default expand level, max recursion depth, max node count to prevent runaway builds

## Usage

### Adding Root Documents

Choose any of:

1. Right-click a document in the SiYuan document tree → **Add to Virtual Document Tree**
2. Right-click the editor title icon → **Add to Virtual Document Tree**
3. Run the command **Add Current Document as Root** from the command palette

### Opening the Panel

After the plugin loads, the virtual document tree panel appears in the bottom-left dock (`LeftBottom` position). Click the icon to expand it.

### Toolbar

| Icon | Action |
| --- | --- |
| Refresh | Rebuild the virtual tree |
| Collapse All | Collapse all parent nodes |
| Expand All | Expand all nodes |
| Locate Current Document | Scroll to the currently active document |
| Focus Current Document | Show only the descendant tree of the active document; click again to exit focus mode |

### Context Menu

Right-click a node in the virtual tree:

- **Open Document**: Open in the current tab
- **Open in New Tab**
- **Remove from Virtual Tree** (root nodes only)

## Settings

Configure in `Settings → Marketplace → Downloaded → Virtual Document Tree`:

| Setting | Description |
| --- | --- |
| Weight attribute name | The custom attribute name used for weight-based sorting; missing values are treated as 0 |
| Default expand level | `0` = collapse all, `-1` = expand all, `N` = expand first N levels |
| Sort method | By name / By weight / Custom (drag-and-drop) |
| Max recursion depth | Maximum recursion depth when building subtrees; prevents infinite recursion |
| Max nodes | Maximum total node count; building stops when exceeded |
| Placeholder text | Text shown when the tree is empty |
| Case sensitive | Whether sorting is case-sensitive |
| Include physical subtree | When enabled, documents' physical children in SiYuan's native hierarchy are also shown as virtual child nodes |

## How It Works

1. **Root nodes**: Documents explicitly added by the user serve as roots of the virtual tree
2. **Parent-child relations**: Scans the **first block** (smallest `sort` non-document block) of every document, parses the reference links it contains (`refs` table); the referenced document becomes the parent, the referencing document becomes the child
3. **Merge & dedupe**: Merges results from 4 SQL strategies to avoid missing relations from any single strategy
4. **Physical subtree (optional)**: When enabled, also fetches documents' physical children from SiYuan's native hierarchy and merges them with reference relations, deduplicated

> Note: The tree is maintained by document IDs, so duplicate document names never conflict.

## Development

### Requirements

- Node.js
- npm

### Scripts

```bash
# Install dependencies
npm install

# Development mode (watches changes, outputs to .src)
npm run dev

# Build and package (outputs dist/package.zip)
npm run build

# Package only
npm run zip

# Clean build artifacts
npm run clean
```

### Build Artifacts

- `npm run dev` / `npm run build`: Compiles TypeScript + SCSS to the `.src/` directory
- `npm run build`: Further packages `.src/` into `dist/package.zip` via `scripts/zip.js`, conforming to the SiYuan plugin marketplace format

Artifact structure:

```
dist/package.zip
├── plugin.json
├── index.js
├── index.css
└── i18n/zh_CN.json
```

### Module Structure

```
src/
├── index.ts          Plugin entry; registers dock / commands / events
├── panel.ts          Panel UI and interaction logic
├── treeBuilder.ts    Virtual tree construction (merges references + physical subtrees)
├── api.ts            SiYuan API wrappers (SQL queries, doc info, reference relations)
├── stateManager.ts   State management and persistence (settings/roots/collapse/custom order)
├── settings.ts       Settings panel UI
├── sorter.ts         Sort implementations
├── disambiguator.ts  Duplicate-name disambiguation
├── constants.ts      Constants (dock type, storage name, command keys, timing)
├── i18n.ts           Translation helper
├── types.ts          Type definitions
├── utils.ts          Common utilities (active doc detection, context menu injection, debounce)
└── index.scss        Styles
```

## Compatibility

- Minimum SiYuan version: 3.6.4
- Backends: Windows / Linux / macOS / Docker
- Frontends: Desktop / Mobile


