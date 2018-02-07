const PRECEDENCE = {};
[
  ['|>'],
  ['||', '??'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '===', '!=', '!=='],
  ['<', '>', '<=', '>=', 'in', 'instanceof'],
  ['>>', '<<', '>>>'],
  ['+', '-'],
  ['*', '/', '%'],
  ['**'],
].forEach((tier, i) => {
  tier.forEach(op => {
    PRECEDENCE[op] = i;
  });
});

const equalityOperators = {
  '==': true,
  '!=': true,
  '===': true,
  '!==': true,
};
const multiplicativeOperators = {
  '*': true,
  '/': true,
  '%': true,
};
const bitshiftOperators = {
  '>>': true,
  '>>>': true,
  '<<': true,
};

function skip(chars) {
  return (text, index, opts) => {
    const backwards = opts && opts.backwards;

    // Allow `skip` functions to be threaded together without having
    // to check for failures (did someone say monads?).
    if (index === false) {
      return false;
    }

    const length = text.length;
    let cursor = index;
    while (cursor >= 0 && cursor < length) {
      const c = text.charAt(cursor);
      if (chars instanceof RegExp) {
        if (!chars.test(c)) {
          return cursor;
        }
      } else if (chars.indexOf(c) === -1) {
        return cursor;
      }

      backwards ? cursor-- : cursor++;
    }

    if (cursor === -1 || cursor === length) {
      // If we reached the beginning or end of the file, return the
      // out-of-bounds cursor. It's up to the caller to handle this
      // correctly. We don't want to indicate `false` though if it
      // actually skipped valid characters.
      return cursor;
    }
    return false;
  };
}

const skipSpaces = skip(' \t');
const skipToLineEnd = skip(',; \t');
const skipEverythingButNewLine = skip(/[^\r\n]/);

function skipInlineComment(text, index) {
  if (index === false) {
    return false;
  }

  if (text.charAt(index) === '/' && text.charAt(index + 1) === '*') {
    for (let i = index + 2; i < text.length; ++i) {
      if (text.charAt(i) === '*' && text.charAt(i + 1) === '/') {
        return i + 2;
      }
    }
  }
  return index;
}

function skipTrailingComment(text, index) {
  if (index === false) {
    return false;
  }

  if (text.charAt(index) === '/' && text.charAt(index + 1) === '/') {
    return skipEverythingButNewLine(text, index);
  }
  return index;
}

// // This one doesn't use the above helper function because it wants to
// // test \r\n in order and `skip` doesn't support ordering and we only
// // want to skip one newline. It's simple to implement.
function skipNewline(text, index, opts) {
  const backwards = opts && opts.backwards;
  if (index === false) {
    return false;
  }

  const atIndex = text.charAt(index);
  if (backwards) {
    if (text.charAt(index - 1) === '\r' && atIndex === '\n') {
      return index - 2;
    }
    if (
      atIndex === '\n' ||
      atIndex === '\r' ||
      atIndex === '\u2028' ||
      atIndex === '\u2029'
    ) {
      return index - 1;
    }
  } else {
    if (atIndex === '\r' && text.charAt(index + 1) === '\n') {
      return index + 2;
    }
    if (
      atIndex === '\n' ||
      atIndex === '\r' ||
      atIndex === '\u2028' ||
      atIndex === '\u2029'
    ) {
      return index + 1;
    }
  }

  return index;
}

function hasNewline(text, index, opts) {
  opts = opts || {};
  const idx = skipSpaces(text, opts.backwards ? index - 1 : index, opts);
  const idx2 = skipNewline(text, idx, opts);
  return idx !== idx2;
}

function isNextLineEmptyAfterIndex(text, index) {
  let oldIdx = null;
  let idx = index;
  while (idx !== oldIdx) {
    // We need to skip all the potential trailing inline comments
    oldIdx = idx;
    idx = skipToLineEnd(text, idx);
    idx = skipInlineComment(text, idx);
    idx = skipSpaces(text, idx);
  }
  idx = skipTrailingComment(text, idx);
  idx = skipNewline(text, idx);
  return hasNewline(text, idx);
}

function isNextLineEmpty(text, node) {
  return isNextLineEmptyAfterIndex(text, locEnd(node));
}

function locEnd(node) {
  const endNode = node.nodes && getLast(node.nodes);
  if (endNode && node.source && !node.source.end) {
    node = endNode;
  }

  let loc;
  if (node.range) {
    loc = node.range[1];
  } else if (typeof node.end === 'number') {
    loc = node.end;
  } else if (node.source) {
    loc = lineColumnToIndex(node.source.end, node.source.input.css);
  }

  if (node.__location) {
    return node.__location.endOffset;
  }
  if (node.typeAnnotation) {
    return Math.max(loc, locEnd(node.typeAnnotation));
  }

  if (node.loc && !loc) {
    return node.loc.end;
  }

  return loc;
}
function getLast(arr) {
  if (arr.length > 0) {
    return arr[arr.length - 1];
  }
  return null;
}
// Super inefficient, needs to be cached.
function lineColumnToIndex(lineColumn, text) {
  let index = 0;
  for (let i = 0; i < lineColumn.line - 1; ++i) {
    index = text.indexOf('\n', index) + 1;
    if (index === -1) {
      return -1;
    }
  }
  return index + lineColumn.column;
}

function locStart(node) {
  // Handle nodes with decorators. They should start at the first decorator
  if (
    node.declaration &&
    node.declaration.decorators &&
    node.declaration.decorators.length > 0
  ) {
    return locStart(node.declaration.decorators[0]);
  }
  if (node.decorators && node.decorators.length > 0) {
    return locStart(node.decorators[0]);
  }

  if (node.__location) {
    return node.__location.startOffset;
  }
  if (node.range) {
    return node.range[0];
  }
  if (typeof node.start === 'number') {
    return node.start;
  }
  if (node.source) {
    return lineColumnToIndex(node.source.start, node.source.input.css) - 1;
  }
  if (node.loc) {
    return node.loc.start;
  }
}

function getLeftMost(node) {
  if (node.left) {
    return getLeftMost(node.left);
  }
  return node;
}

// Tests if an expression starts with `{`, or (if forbidFunctionAndClass holds) `function` or `class`.
// Will be overzealous if there's already necessary grouping parentheses.
function startsWithNoLookaheadToken(node, forbidFunctionAndClass) {
  node = getLeftMost(node);
  switch (node.type) {
    // Hack. Remove after https://github.com/eslint/typescript-eslint-parser/issues/331
    case 'ObjectPattern':
      return !forbidFunctionAndClass;
    case 'FunctionExpression':
    case 'ClassExpression':
      return forbidFunctionAndClass;
    case 'ObjectExpression':
      return true;
    case 'MemberExpression':
      return startsWithNoLookaheadToken(node.object, forbidFunctionAndClass);
    case 'TaggedTemplateExpression':
      if (node.tag.type === 'FunctionExpression') {
        // IIFEs are always already parenthesized
        return false;
      }
      return startsWithNoLookaheadToken(node.tag, forbidFunctionAndClass);
    case 'CallExpression':
      if (node.callee.type === 'FunctionExpression') {
        // IIFEs are always already parenthesized
        return false;
      }
      return startsWithNoLookaheadToken(node.callee, forbidFunctionAndClass);
    case 'ConditionalExpression':
      return startsWithNoLookaheadToken(node.test, forbidFunctionAndClass);
    case 'UpdateExpression':
      return (
        !node.prefix &&
        startsWithNoLookaheadToken(node.argument, forbidFunctionAndClass)
      );
    case 'BindExpression':
      return (
        node.object &&
        startsWithNoLookaheadToken(node.object, forbidFunctionAndClass)
      );
    case 'SequenceExpression':
      return startsWithNoLookaheadToken(
        node.expressions[0],
        forbidFunctionAndClass,
      );
    case 'TSAsExpression':
      return startsWithNoLookaheadToken(
        node.expression,
        forbidFunctionAndClass,
      );
    default:
      return false;
  }
}

function hasClosureCompilerTypeCastComment(text, node) {
  // https://github.com/google/closure-compiler/wiki/Annotating-Types#type-casts
  // Syntax example: var x = /** @type {string} */ (fruit);
  return (
    node.comments &&
    node.comments.some(
      comment =>
        comment.leading &&
        isBlockComment(comment) &&
        comment.value.match(/^\*\s*@type\s*{[^}]+}\s*$/) &&
        getNextNonSpaceNonCommentCharacter(text, comment) === '(',
    )
  );
}

function getPrecedence(op) {
  return PRECEDENCE[op];
}

function shouldFlatten(parentOp, nodeOp) {
  if (getPrecedence(nodeOp) !== getPrecedence(parentOp)) {
    return false;
  }

  // ** is right-associative
  // x ** y ** z --> x ** (y ** z)
  if (parentOp === '**') {
    return false;
  }

  // x == y == z --> (x == y) == z
  if (equalityOperators[parentOp] && equalityOperators[nodeOp]) {
    return false;
  }

  // x * y % z --> (x * y) % z
  if (
    (nodeOp === '%' && multiplicativeOperators[parentOp]) ||
    (parentOp === '%' && multiplicativeOperators[nodeOp])
  ) {
    return false;
  }

  // x << y << z --> (x << y) << z
  if (bitshiftOperators[parentOp] && bitshiftOperators[nodeOp]) {
    return false;
  }

  return true;
}

function isBitwiseOperator(operator) {
  return (
    !!bitshiftOperators[operator] ||
    operator === '|' ||
    operator === '^' ||
    operator === '&'
  );
}

function isBlockComment(comment) {
  return comment.type === 'Block' || comment.type === 'CommentBlock';
}

function getNextNonSpaceNonCommentCharacterIndex(text, node) {
  let oldIdx = null;
  let idx = locEnd(node);
  while (idx !== oldIdx) {
    oldIdx = idx;
    idx = skipSpaces(text, idx);
    idx = skipInlineComment(text, idx);
    idx = skipTrailingComment(text, idx);
    idx = skipNewline(text, idx);
  }
  return idx;
}

function getNextNonSpaceNonCommentCharacter(text, node) {
  return text.charAt(getNextNonSpaceNonCommentCharacterIndex(text, node));
}

function stringWidth(text) {
  return text.length;
}

function getStringWidth(text) {
  if (!text) {
    return 0;
  }

  return stringWidth(text);
}

export {
  locStart,
  isNextLineEmpty,
  startsWithNoLookaheadToken,
  getPrecedence,
  shouldFlatten,
  isBitwiseOperator,
  hasClosureCompilerTypeCastComment,
  getStringWidth,
};
