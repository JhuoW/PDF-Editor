import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFObjectCopier, PDFRef, type PDFPage, type PDFObject } from 'pdf-lib';
import { clonePDFPageLink, createPDFLinkDestinationResolver, type ResolvedPDFLinkDestination } from './PDFLinkDestinations';
import { PDF_BOOKMARK_LIMITS as LIMIT } from './PDFBookmarksTypes';
const key = PDFName.of;
interface Node { ref: PDFRef; dictionary: PDFDict; expanded: boolean; children: Node[] }
interface Tree { root?: PDFDict; rootRef?: PDFRef; nodes: Node[] }
const has = (dict: PDFDict, name: string) => dict.has(key(name)) && dict.lookup(key(name)) !== PDFNull;
function read(pdf: PDFDocument): Tree {
  const raw = pdf.catalog.get(key('Outlines')), root = pdf.context.lookup(raw);
  if (root === undefined || root === PDFNull) return { nodes: [] };
  if (!(raw instanceof PDFRef) || !(root instanceof PDFDict)) throw new Error('The bookmark root is malformed.');
  const visited = new Set<PDFDict>();
  const walk = (parent: PDFDict, parentRef: PDFRef, depth: number): Node[] => {
    if (depth > LIMIT.depth && has(parent, 'First')) throw new Error('Bookmark nesting exceeds the supported depth.');
    let next = parent.get(key('First')), previous: PDFRef | undefined; const nodes: Node[] = [];
    while (next && next !== PDFNull) {
      const dictionary = pdf.context.lookup(next);
      if (!(next instanceof PDFRef) || !(dictionary instanceof PDFDict) || visited.has(dictionary) || visited.size >= LIMIT.bookmarks) throw new Error('The bookmark tree is circular, shared, malformed, or too large.');
      visited.add(dictionary);
      if (dictionary.get(key('Parent'))?.toString() !== parentRef.toString() || (previous ? dictionary.get(key('Prev'))?.toString() !== previous.toString() : has(dictionary, 'Prev'))) throw new Error('A bookmark parent or sibling relationship is invalid.');
      const count = dictionary.lookup(key('Count'));
      nodes.push({ ref: next, dictionary, expanded: !(count instanceof PDFNumber) || count.asNumber() >= 0, children: walk(dictionary, next, depth + 1) });
      previous = next; next = dictionary.get(key('Next'));
    }
    if (previous ? parent.get(key('Last'))?.toString() !== previous.toString() : has(parent, 'Last')) throw new Error('A bookmark last-item relationship is invalid.');
    return nodes;
  };
  return { root, rootRef: raw, nodes: walk(root, raw, 1) };
}
function write(pdf: PDFDocument, tree: Tree) {
  if (!tree.nodes.length) { pdf.catalog.delete(key('Outlines')); return; }
  const root = tree.root ?? pdf.context.obj({ Type: 'Outlines' }), rootRef = tree.rootRef ?? pdf.context.register(root);
  const wire = (nodes: Node[], parent: PDFDict, parentRef: PDFRef): number => {
    parent.delete(key('First')); parent.delete(key('Last'));
    if (nodes.length) { parent.set(key('First'), nodes[0].ref); parent.set(key('Last'), nodes.at(-1)!.ref); }
    let visible = 0;
    nodes.forEach((node, index) => {
      const dict = node.dictionary; dict.set(key('Parent'), parentRef); dict.delete(key('Prev')); dict.delete(key('Next'));
      if (index) dict.set(key('Prev'), nodes[index - 1].ref); if (index < nodes.length - 1) dict.set(key('Next'), nodes[index + 1].ref);
      const descendants = wire(node.children, dict, node.ref);
      if (descendants) dict.set(key('Count'), PDFNumber.of(node.expanded ? descendants : -descendants)); else dict.delete(key('Count'));
      visible += 1 + (node.expanded ? descendants : 0);
    });
    return visible;
  };
  root.set(key('Count'), PDFNumber.of(wire(tree.nodes, root, rootRef))); pdf.catalog.set(key('Outlines'), rootRef);
}
function slots(pdf: PDFDocument, tree: Tree) {
  const resolve = createPDFLinkDestinationResolver(pdf), result = new Map<Node, ResolvedPDFLinkDestination[]>();
  const walk = (nodes: Node[]) => { for (const node of nodes) {
    const targets: ResolvedPDFLinkDestination[] = [], visited = new Set<PDFObject>();
    const dest = (value: PDFObject | undefined) => { if (!value || value === PDFNull) return; const resolved = resolve(value); if (!resolved) throw new Error('A bookmark has an invalid or ambiguous internal destination.'); targets.push(resolved); };
    let count = 0;
    const action = (raw: PDFObject | undefined, depth = 0) => {
      const value = pdf.context.lookup(raw); if (value === undefined || value === PDFNull) return;
      if (visited.has(value) || depth > LIMIT.depth || ++count > 100000) throw new Error('A bookmark action chain is circular or too large.');
      visited.add(value);
      try {
        if (value instanceof PDFArray) value.asArray().forEach(item => action(item, depth + 1));
        else if (value instanceof PDFDict) { if (value.lookup(key('S')) === key('GoTo')) { if (!has(value, 'D')) throw new Error('A bookmark action has no destination.'); dest(value.get(key('D'))); } action(value.get(key('Next')), depth + 1); }
        else throw new Error('A bookmark action is malformed.');
      } finally { visited.delete(value); }
    };
    dest(node.dictionary.get(key('Dest'))); action(node.dictionary.get(key('A')));
    const additional = node.dictionary.lookup(key('AA')); if (additional instanceof PDFDict) additional.values().forEach(value => action(value));
    result.set(node, targets); walk(node.children);
  } };
  walk(tree.nodes); return result;
}
/** Preserve legacy numeric destinations before changing page indices. */
export function stabilizePDFBookmarkPageReferences(pdf: PDFDocument) {
  const tree = read(pdf), targets = slots(pdf, tree), pages = pdf.getPages();
  for (const values of targets.values()) for (const target of values) if (target.destination.get(0) instanceof PDFNumber) target.destination.set(0, pages[target.pageNumber - 1].ref);
}
/** A removed target drops its leaf, or leaves a non-clickable heading for surviving children. */
export function removePDFBookmarksToPages(pdf: PDFDocument, deleted: Set<number>) {
  const tree = read(pdf), targets = slots(pdf, tree);
  for (const [node, values] of targets) if (values.some(value => deleted.has(value.pageNumber)) && has(node.dictionary, 'SE')) throw new Error('Deleting this page would modify a structure-linked bookmark, which is not supported.');
  const prune = (nodes: Node[]): Node[] => nodes.flatMap(node => {
    const children = prune(node.children), missing = targets.get(node)!.some(value => deleted.has(value.pageNumber));
    if (missing && !children.length) return [];
    if (missing) { node.dictionary.delete(key('Dest')); node.dictionary.delete(key('A')); node.dictionary.delete(key('AA')); }
    return [{ ...node, children }];
  });
  tree.nodes = prune(tree.nodes); write(pdf, tree);
}
/** Validate and detach source outline graph before copying any pages into target. */
export function preparePDFBookmarkCopy(target: PDFDocument, source: PDFDocument, indices: number[]): (pages: PDFPage[]) => void {
  if (!indices.length) return () => {};
  const donor = read(source), existing = read(target), selected = new Set(indices.map(index => index + 1));
  const resolve = createPDFLinkDestinationResolver(source);
  interface Plan { expanded: boolean; link: ReturnType<typeof clonePDFPageLink>; children: Plan[] }
  const plan = (nodes: Node[]): Plan[] => nodes.flatMap(node => {
    const children = plan(node.children), dictionary = node.dictionary.clone();
    for (const property of ['Parent', 'Prev', 'Next', 'First', 'Last', 'Count']) dictionary.delete(key(property));
    for (const property of ['Dest', 'A', 'AA']) if (dictionary.lookup(key(property)) === PDFNull) dictionary.delete(key(property));
    // Structure targets cannot travel without copying their document structure tree.
    if (has(dictionary, 'SE')) throw new Error('Copying structure-linked bookmarks is not supported.');
    const link = clonePDFPageLink(source, dictionary, resolve), missing = link.destinations.some(slot => !selected.has(slot.resolved.pageNumber));
    if (missing && !children.length) return [];
    if (missing) { link.annotation.delete(key('Dest')); link.annotation.delete(key('A')); link.annotation.delete(key('AA')); link.destinations = []; }
    return [{ expanded: node.expanded, link, children }];
  });
  const planned = plan(donor.nodes);
  interface Branch { children: Branch[] }
  const count = (nodes: Branch[]): number => nodes.reduce((total, node) => total + 1 + count(node.children), 0);
  if (count(existing.nodes) + count(planned) > LIMIT.bookmarks) throw new Error('The combined PDF exceeds the 10,000-bookmark limit.');
  return pages => {
    if (!planned.length) return;
    const map = new Map<number, PDFPage>(); indices.forEach((index, position) => { if (!map.has(index + 1)) map.set(index + 1, pages[position]); });
    const copier = PDFObjectCopier.for(source.context, target.context);
    const copy = (items: Plan[]): Node[] => items.map(item => {
      const dictionary = copier.copy(item.link.annotation), ref = target.context.register(dictionary);
      for (const slot of item.link.destinations) copier.copy(slot.dictionary).set(slot.key, target.context.obj([map.get(slot.resolved.pageNumber)!.ref, ...slot.resolved.destination.asArray().slice(1).map(value => copier.copy(value))]));
      return { dictionary, ref, expanded: item.expanded, children: copy(item.children) };
    });
    existing.nodes.push(...copy(planned)); write(target, existing);
  };
}
