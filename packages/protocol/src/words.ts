import { sha256 } from '@noble/hashes/sha2.js';
import type { KeyId } from './types.ts';

export const WORDS: readonly string[] = [
  'able', 'acid', 'aged', 'also', 'area', 'army', 'atom', 'aunt',
  'away', 'baby', 'back', 'ball', 'band', 'bank', 'barn', 'base',
  'bath', 'bead', 'beam', 'bear', 'beat', 'bell', 'belt', 'bike',
  'bird', 'blue', 'boat', 'bold', 'bone', 'book', 'boot', 'bowl',
  'brad', 'bulb', 'bush', 'cabin', 'cake', 'calm', 'camp', 'card',
  'cart', 'cave', 'chip', 'city', 'clay', 'clip', 'cloud', 'coal',
  'coat', 'code', 'coin', 'cold', 'cook', 'cool', 'copy', 'cord',
  'corn', 'crab', 'crew', 'crop', 'cube', 'curl', 'dairy', 'dark',
  'dart', 'dawn', 'deer', 'desk', 'dial', 'dice', 'dish', 'dock',
  'dome', 'door', 'dove', 'down', 'draw', 'drum', 'duck', 'dune',
  'dust', 'east', 'edge', 'elm', 'ember', 'epic', 'fair', 'farm',
  'fern', 'file', 'fire', 'fish', 'flag', 'flat', 'fog', 'fork',
  'fort', 'fox', 'frog', 'gate', 'gear', 'gift', 'glow', 'goat',
  'gold', 'gulf', 'hall', 'hand', 'hawk', 'hill', 'hive', 'home',
  'hood', 'horn', 'hull', 'iron', 'isle', 'ivory', 'jade', 'jazz',
  'jewel', 'jolly', 'keen', 'kelp', 'kite', 'knot', 'lake', 'lamp',
  'lark', 'leaf', 'lens', 'lily', 'lion', 'loft', 'lone', 'luck',
  'lynx', 'mail', 'maple', 'mask', 'mesh', 'mint', 'moon', 'moss',
  'moth', 'nest', 'noon', 'note', 'oak', 'oasis', 'ocean', 'olive',
  'opal', 'orbit', 'otter', 'oval', 'owl', 'palm', 'park', 'path',
  'pearl', 'pine', 'plum', 'pond', 'pony', 'port', 'quail', 'quartz',
  'quiet', 'rain', 'raven', 'reef', 'ribbon', 'ridge', 'river', 'road',
  'rock', 'roof', 'rose', 'ruby', 'sage', 'sail', 'salt', 'sand',
  'seal', 'seed', 'shell', 'silk', 'slate', 'snow', 'sock', 'soda',
  'star', 'stone', 'storm', 'sugar', 'swan', 'tarp', 'tent', 'tide',
  'tiger', 'toad', 'tower', 'trail', 'tulip', 'twig', 'urn', 'vale',
  'vine', 'wagon', 'wave', 'wheat', 'wind', 'wolf', 'wood', 'yarn',
  'yeti', 'zebra', 'zinc', 'amber', 'anvil', 'aspen', 'badge', 'basil',
  'birch', 'bison', 'blaze', 'brook', 'cedar', 'chalk', 'cider', 'cliff',
  'comet', 'coral', 'daisy', 'delta', 'eagle', 'ferry', 'finch', 'flint',
  'frost', 'glade', 'grove', 'heron', 'hazel', 'indigo', 'jaguar', 'kayak',
  'lemon', 'lotus', 'magma', 'marsh', 'mango', 'nectar', 'onyx', 'pebble',
];

/** Order-independent phrase both parties read aloud to confirm they hold the same two keys. */
export function fourWordCode(a: KeyId, b: KeyId): string {
  const [first, second] = a < b ? [a, b] : [b, a];
  const digest = sha256(new TextEncoder().encode(`${first}|${second}`));
  return Array.from(digest.slice(0, 4), (byte) => WORDS[byte]!).join('-');
}
