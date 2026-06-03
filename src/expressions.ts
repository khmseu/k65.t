export interface ExpressionEvaluation {
  readonly value: number | null;
  readonly error: string | null;
  readonly errorCode: string | null;
  readonly errorColumn: number | null;
}

export function evaluateExpression(
  expression: string,
  symbols: ReadonlyMap<string, number>,
  location: number,
): number | null {
  return evaluateExpressionDetailed(expression, symbols, location).value;
}

export function evaluateExpressionDetailed(
  expression: string,
  symbols: ReadonlyMap<string, number>,
  location: number,
): ExpressionEvaluation {
  const parser = new ExpressionParser(expression, symbols, location);
  return parser.parseDetailed();
}

class ExpressionParser {
  private readonly input: string;
  private readonly symbols: ReadonlyMap<string, number>;
  private readonly location: number;
  private position = 0;
  private error: string | null = null;
  private errorCode: string | null = null;
  private errorColumn: number | null = null;

  constructor(
    input: string,
    symbols: ReadonlyMap<string, number>,
    location: number,
  ) {
    this.input = input;
    this.symbols = symbols;
    this.location = location;
  }

  parseDetailed(): ExpressionEvaluation {
    this.skipWhitespace();
    if (this.position >= this.input.length) {
      return {
        value: null,
        error: "empty expression",
        errorCode: "E_EXPR_EMPTY",
        errorColumn: 1,
      };
    }

    const value = this.parseBitwiseOr();
    if (value === null) {
      return {
        value: null,
        error: this.error ?? "invalid expression",
        errorCode: this.errorCode ?? "E_EXPR_INVALID",
        errorColumn: this.errorColumn ?? this.position + 1,
      };
    }

    this.skipWhitespace();
    if (this.position !== this.input.length) {
      return {
        value: null,
        error: `unexpected token '${this.input[this.position] ?? "<eof>"}' at column ${this.position + 1}`,
        errorCode: "E_EXPR_UNEXPECTED_TOKEN",
        errorColumn: this.position + 1,
      };
    }

    return {
      value: value & 0xffff,
      error: null,
      errorCode: null,
      errorColumn: null,
    };
  }

  private parseBitwiseOr(): number | null {
    let left = this.parseBitwiseXor();

    while (left !== null) {
      this.skipWhitespace();
      if (!this.consume("|")) {
        break;
      }

      const right = this.parseBitwiseXor();
      if (right === null) {
        return null;
      }

      left = (left | right) & 0xffff;
    }

    return left;
  }

  private parseBitwiseXor(): number | null {
    let left = this.parseBitwiseAnd();

    while (left !== null) {
      this.skipWhitespace();
      if (!this.consume("^")) {
        break;
      }

      const right = this.parseBitwiseAnd();
      if (right === null) {
        return null;
      }

      left = (left ^ right) & 0xffff;
    }

    return left;
  }

  private parseBitwiseAnd(): number | null {
    let left = this.parseAdditive();

    while (left !== null) {
      this.skipWhitespace();
      if (!this.consume("&")) {
        break;
      }

      const right = this.parseAdditive();
      if (right === null) {
        return null;
      }

      left = left & right & 0xffff;
    }

    return left;
  }

  private parseAdditive(): number | null {
    let left = this.parseMultiplicative();

    while (left !== null) {
      this.skipWhitespace();
      if (this.consume("+")) {
        const right = this.parseMultiplicative();
        if (right === null) {
          return null;
        }
        left = (left + right) & 0xffff;
        continue;
      }

      if (this.consume("-")) {
        const right = this.parseMultiplicative();
        if (right === null) {
          return null;
        }
        left = (left - right) & 0xffff;
        continue;
      }

      break;
    }

    return left;
  }

  private parseMultiplicative(): number | null {
    let left = this.parseUnary();

    while (left !== null) {
      this.skipWhitespace();
      if (this.consume("*")) {
        const right = this.parseUnary();
        if (right === null) {
          return null;
        }
        left = (left * right) & 0xffff;
        continue;
      }

      if (this.consume("/")) {
        const operatorColumn = this.position;
        const right = this.parseUnary();
        if (right === null || right === 0) {
          this.fail("division by zero", "E_EXPR_DIV_BY_ZERO", operatorColumn);
          return null;
        }
        left = Math.trunc(left / right) & 0xffff;
        continue;
      }

      if (this.consume("%")) {
        const operatorColumn = this.position;
        const right = this.parseUnary();
        if (right === null || right === 0) {
          this.fail("modulo by zero", "E_EXPR_MOD_BY_ZERO", operatorColumn);
          return null;
        }
        left = (left % right) & 0xffff;
        continue;
      }

      break;
    }

    return left;
  }

  private parseUnary(): number | null {
    this.skipWhitespace();

    if (this.consume("+")) {
      return this.parseUnary();
    }

    if (this.consume("-")) {
      const value = this.parseUnary();
      return value === null ? null : -value & 0xffff;
    }

    if (this.consume("~")) {
      const value = this.parseUnary();
      return value === null ? null : ~value & 0xffff;
    }

    if (this.consume("<")) {
      const value = this.parseUnary();
      return value === null ? null : value & 0xff;
    }

    if (this.consume(">")) {
      const value = this.parseUnary();
      return value === null ? null : (value >> 8) & 0xff;
    }

    return this.parsePrimary();
  }

  private parsePrimary(): number | null {
    this.skipWhitespace();

    if (this.consume("(")) {
      const openColumn = this.position;
      const value = this.parseBitwiseOr();
      this.skipWhitespace();
      if (value === null || !this.consume(")")) {
        this.fail(
          "missing ')' in expression",
          "E_EXPR_MISSING_RPAREN",
          openColumn,
        );
        return null;
      }
      return value;
    }

    if (this.peek() === "*") {
      this.position += 1;
      return this.location & 0xffff;
    }

    const stringLiteral = this.parseSingleCharStringLiteral();
    if (stringLiteral !== undefined) {
      return stringLiteral;
    }

    const number = this.parseNumber();
    if (number !== null) {
      return number;
    }

    const identifier = this.parseIdentifier();
    if (identifier !== null) {
      const identifierColumn = this.position - identifier.length + 1;
      const resolved = this.symbols.get(identifier.toUpperCase());
      if (resolved === undefined) {
        this.fail(
          `unknown symbol '${identifier}'`,
          "E_EXPR_UNKNOWN_SYMBOL",
          identifierColumn,
        );
        return null;
      }

      return resolved;
    }

    this.fail(
      `invalid token '${this.input[this.position] ?? "<eof>"}' at column ${this.position + 1}`,
      "E_EXPR_INVALID_TOKEN",
      this.position + 1,
    );
    return null;
  }

  private parseSingleCharStringLiteral(): number | null | undefined {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") {
      return undefined;
    }

    const startColumn = this.position + 1;
    this.position += 1;

    if (this.position >= this.input.length) {
      this.fail(
        "unterminated string literal",
        "E_EXPR_STRING_UNTERMINATED",
        startColumn,
      );
      return null;
    }

    let value: number;
    const ch = this.input[this.position]!;
    if (ch === "\\") {
      this.position += 1;
      const escaped = this.parseEscapedCharacter(startColumn);
      if (escaped === null) {
        return null;
      }
      value = escaped;
    } else {
      value = ch.charCodeAt(0);
      this.position += 1;
    }

    const closing = this.peek();
    if (closing === undefined) {
      this.fail(
        "unterminated string literal",
        "E_EXPR_STRING_UNTERMINATED",
        startColumn,
      );
      return null;
    }

    if (closing !== quote) {
      this.fail(
        "expression string literal must contain exactly one character",
        "E_EXPR_STRING_LENGTH",
        startColumn,
      );
      return null;
    }

    this.position += 1;
    return value & 0xffff;
  }

  private parseEscapedCharacter(startColumn: number): number | null {
    if (this.position >= this.input.length) {
      this.fail(
        "invalid escape in string literal",
        "E_EXPR_STRING_ESCAPE",
        startColumn,
      );
      return null;
    }

    const escaped = this.input[this.position]!;
    this.position += 1;

    if (escaped === "n") {
      return 0x0a;
    }
    if (escaped === "r") {
      return 0x0d;
    }
    if (escaped === "t") {
      return 0x09;
    }
    if (escaped === "\\") {
      return 0x5c;
    }
    if (escaped === '"') {
      return 0x22;
    }
    if (escaped === "'") {
      return 0x27;
    }

    if (escaped === "x") {
      const hex = this.input.slice(this.position, this.position + 2);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        this.position += 2;
        return Number.parseInt(hex, 16);
      }

      this.fail(
        "invalid \\xHH escape in string literal",
        "E_EXPR_STRING_ESCAPE",
        startColumn,
      );
      return null;
    }

    this.fail(
      "invalid escape in string literal",
      "E_EXPR_STRING_ESCAPE",
      startColumn,
    );
    return null;
  }

  private parseNumber(): number | null {
    const rest = this.input.slice(this.position);
    const hexDollar = rest.match(/^\$([0-9a-f]+)/i);
    if (hexDollar?.[1] !== undefined) {
      this.position += hexDollar[0].length;
      return Number.parseInt(hexDollar[1], 16);
    }

    const hex0x = rest.match(/^0x([0-9a-f]+)/i);
    if (hex0x?.[1] !== undefined) {
      this.position += hex0x[0].length;
      return Number.parseInt(hex0x[1], 16);
    }

    const binary = rest.match(/^%([01]+)/);
    if (binary?.[1] !== undefined) {
      this.position += binary[0].length;
      return Number.parseInt(binary[1], 2);
    }

    const decimal = rest.match(/^[0-9]+/);
    if (decimal?.[0] !== undefined) {
      this.position += decimal[0].length;
      return Number.parseInt(decimal[0], 10);
    }

    return null;
  }

  private parseIdentifier(): string | null {
    const rest = this.input.slice(this.position);
    const match = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (match?.[0] === undefined) {
      return null;
    }

    this.position += match[0].length;
    return match[0];
  }

  private consume(token: string): boolean {
    if (this.input.startsWith(token, this.position)) {
      this.position += token.length;
      return true;
    }

    return false;
  }

  private peek(): string | undefined {
    return this.input[this.position];
  }

  private skipWhitespace(): void {
    while (
      this.position < this.input.length &&
      /\s/.test(this.input[this.position]!)
    ) {
      this.position += 1;
    }
  }

  private fail(message: string, code: string, column: number): void {
    if (this.error === null) {
      this.error = message;
      this.errorCode = code;
      this.errorColumn = column;
    }
  }
}
