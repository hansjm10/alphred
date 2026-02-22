// @vitest-environment jsdom

import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import NewWorkflowPage from './page';

describe('NewWorkflowPage', () => {
  it('renders the create workflow form', () => {
    expect(isValidElement(NewWorkflowPage())).toBe(true);
  });
});
