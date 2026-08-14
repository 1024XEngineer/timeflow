import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';

import { PhoneCallIcon } from '../../../../../src/features/assistant/presentation/PhoneCallIcon';

interface RenderedNode {
  props: Record<string, unknown>;
  children: readonly (RenderedNode | string)[] | null;
}

function firstChild(node: RenderedNode): RenderedNode {
  const child = node.children?.[0];
  if (child == null || typeof child === 'string') {
    throw new Error('expected an element child');
  }
  return child;
}

describe('PhoneCallIcon', () => {
  it('renders with the default size', () => {
    const tree = render(<PhoneCallIcon />).toJSON() as RenderedNode;
    expect(tree.props).toMatchObject({ height: 22, width: 22 });
  });

  it('applies a custom color and size', () => {
    const tree = render(<PhoneCallIcon color="#112233" size={40} />).toJSON() as RenderedNode;
    expect(tree.props).toMatchObject({ height: 40, width: 40 });
    // react-native-svg 编译成原生 props 时把颜色打包成 ARGB payload，不是原始 hex 字符串。
    const path = firstChild(firstChild(tree));
    expect((path.props.stroke as { payload: number }).payload).toBe(0xff112233);
  });
});
