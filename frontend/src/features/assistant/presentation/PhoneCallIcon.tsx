import Svg, { Path } from 'react-native-svg';

/** 电话听筒图标，用在免提通话的入口按钮和收起控件上。 */
export function PhoneCallIcon({ color = '#FFFFFF', size = 22 }: { color?: string; size?: number }) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <Path
        d="M6.6 10.8c1.3 2.6 3.4 4.7 6 6l2-2c.3-.3.7-.4 1-.3 1.1.4 2.3.6 3.5.6.6 0 1 .4 1 1v3.5c0 .6-.4 1-1 1C10.6 20.6 3.4 13.4 3.4 5c0-.6.4-1 1-1H8c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.3 0 .7-.3 1l-2.1 2.3Z"
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={1.65}
      />
    </Svg>
  );
}
