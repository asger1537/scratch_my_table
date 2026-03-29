import * as Blockly from 'blockly';

const COMMENT_WRAP_LIMIT = 32;
const COMMENT_LINE_SPACING = 4;
const COMMENT_FIELD_WIDTH = 320;

export function wrapCommentDisplayLines(text: string, wrapLimit = COMMENT_WRAP_LIMIT) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const paragraphs = normalized.split('\n');
  const lines = paragraphs.flatMap((paragraph) => {
    if (paragraph.length === 0) {
      return [''];
    }

    const wrappedParagraph = wrapText(paragraph, wrapLimit);
    return wrappedParagraph ? wrappedParagraph.split('\n') : [''];
  });

  return lines.length > 0 ? lines : [''];
}

export class FieldCommentInput extends Blockly.FieldTextInput {
  constructor(value = 'Add a workflow note') {
    super(value);
    this.maxDisplayLength = 10_000;
    this.setSpellcheck(true);
  }

  protected override render_(): void {
    if (this.isBeingEdited_) {
      super.render_();
      return;
    }

    if (!this.textElement_) {
      return;
    }

    const textElement = this.getTextElement();
    const constants = this.getConstants();
    if (!constants) {
      return;
    }
    const xPadding = this.isFullBlockField() ? 0 : constants.FIELD_BORDER_RECT_X_PADDING;
    const yPadding = this.isFullBlockField() ? 0 : constants.FIELD_BORDER_RECT_Y_PADDING;
    const lineHeight = constants.FIELD_TEXT_HEIGHT + COMMENT_LINE_SPACING;
    const firstLineBaseline = yPadding + constants.FIELD_TEXT_BASELINE;
    const lines = wrapCommentDisplayLines(this.getText());
    const rtl = this.getSourceBlock()?.RTL ?? false;

    while (textElement.firstChild) {
      textElement.removeChild(textElement.firstChild);
    }

    textElement.removeAttribute('dominant-baseline');
    textElement.setAttribute('text-anchor', rtl ? 'end' : 'start');

    lines.forEach((line, index) => {
      const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      tspan.textContent = toSvgDisplayText(line, rtl);
      tspan.setAttribute('y', String(firstLineBaseline + (index * lineHeight)));
      textElement.appendChild(tspan);
    });

    const contentHeight = constants.FIELD_TEXT_HEIGHT + ((Math.max(lines.length, 1) - 1) * lineHeight);
    const width = COMMENT_FIELD_WIDTH;
    const height = Math.max(contentHeight + (yPadding * 2), constants.FIELD_BORDER_RECT_HEIGHT);

    this.size_ = new Blockly.utils.Size(width, height);

    const xPosition = rtl ? width - xPadding : xPadding;

    Array.from(textElement.querySelectorAll('tspan')).forEach((lineElement) => {
      lineElement.setAttribute('x', String(xPosition));
    });

    this.positionBorderRect_();
  }
}

function toSvgDisplayText(value: string, rtl: boolean) {
  const withNonBreakingSpaces = value.replace(/\s/g, Blockly.Field.NBSP);
  return rtl ? `${withNonBreakingSpaces}\u200f` : withNonBreakingSpaces;
}

function wrapText(text: string, wrapLimit: number) {
  return Blockly.utils.string.wrap(text, wrapLimit);
}
