import React from 'react';
import { Tooltip } from 'antd';

export default function BatchControlTitle({ children, tip }) {
  return <Tooltip title={tip}>
    <span data-batch-control-title tabIndex={0}
      style={{ fontSize: 12, fontWeight: 600, color: '#000', cursor: 'help',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif" }}>{children}</span>
  </Tooltip>;
}
