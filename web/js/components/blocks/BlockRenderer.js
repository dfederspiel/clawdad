import { html } from 'htm/preact';
import { TextBlock } from './TextBlock.js';
import { CodeBlock } from './CodeBlock.js';
import { AlertBlock } from './AlertBlock.js';
import { CardBlock } from './CardBlock.js';
import { TableBlock } from './TableBlock.js';
import { StatBlock } from './StatBlock.js';
import { ProgressBlock } from './ProgressBlock.js';
import { ActionBlock } from './ActionBlock.js';
import { DiffBlock } from './DiffBlock.js';
import { FormBlock } from './FormBlock.js';
import { SoundBlock } from './SoundBlock.js';
import { ImageBlock } from './ImageBlock.js';

const RENDERERS = {
  text: TextBlock,
  code: CodeBlock,
  alert: AlertBlock,
  card: CardBlock,
  table: TableBlock,
  stat: StatBlock,
  progress: ProgressBlock,
  action: ActionBlock,
  diff: DiffBlock,
  form: FormBlock,
  sound: SoundBlock,
  image: ImageBlock,
};

export function BlockRenderer({ block }) {
  const Component = RENDERERS[block.type] || TextBlock;
  return html`<${Component} ...${block} />`;
}
