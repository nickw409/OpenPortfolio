// Flags raw arithmetic on values typed as Money. Per
// docs/specs/2026-05-15-money-primitive-design.md M3-A. The Money brand
// is `{ readonly __brand: 'money' }`; we detect it via type info.
import { ESLintUtils } from '@typescript-eslint/utils';

const ARITHMETIC_BINARY = new Set(['+', '-', '*', '/', '%', '**']);
const ARITHMETIC_ASSIGN = new Set(['+=', '-=', '*=', '/=', '%=', '**=']);
const ARITHMETIC_UNARY = new Set(['-', '+']);

function hasMoneyBrand(type, checker) {
  const types = type.isIntersection?.() ? type.types : [type];
  for (const t of types) {
    const brand = t.getProperty?.('__brand');
    if (!brand) continue;
    const decl = brand.declarations?.[0];
    if (!decl) continue;
    const brandType = checker.getTypeOfSymbolAtLocation(brand, decl);
    if (brandType.isStringLiteral?.() && brandType.value === 'money') {
      return true;
    }
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw arithmetic on Money values; use helpers from src/shared/money instead.',
    },
    messages: {
      forbidden:
        'Raw arithmetic on Money is forbidden. Use add/subtract/multiplyByRatio/divideByRatio/etc. from src/shared/money.',
    },
    schema: [],
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    const isMoneyNode = (node) => {
      try {
        return hasMoneyBrand(services.getTypeAtLocation(node), checker);
      } catch {
        return false;
      }
    };

    return {
      BinaryExpression(node) {
        if (!ARITHMETIC_BINARY.has(node.operator)) return;
        if (isMoneyNode(node.left) || isMoneyNode(node.right)) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
      AssignmentExpression(node) {
        if (!ARITHMETIC_ASSIGN.has(node.operator)) return;
        if (isMoneyNode(node.left) || isMoneyNode(node.right)) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
      UnaryExpression(node) {
        if (!ARITHMETIC_UNARY.has(node.operator)) return;
        if (isMoneyNode(node.argument)) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
      UpdateExpression(node) {
        if (isMoneyNode(node.argument)) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
    };
  },
};
