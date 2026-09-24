// --- WO-MATRIX-M1-MINIMAX-01 (WO-HARNESS-BASE-BRANCH-SUBSTITUTION-BOUNDARY-01) ---
  // Workflow variables must match only as whole identifiers, so a longer shell
  // variable that begins with a workflow variable name (e.g. $BASE_BRANCH_OVERRIDE,
  // $BASE_BRANCH_PR) is left verbatim for the bash node. bdc-harness#877.

  // Test 1: prefix-longer variables are left intact.
  it('leaves prefix-longer variables ($BASE_BRANCH_OVERRIDE, $BASE_BRANCH_PR) intact', () => {
    const { prompt } = substituteWorkflowVariables(
      'BASE_BRANCH_OVERRIDE=$BASE_BRANCH_OVERRIDE and BASE_BRANCH_PR=$BASE_BRANCH_PR',
      'run-1',
      'msg',
      '/tmp',
      'dev',
      'docs/'
    );
    expect(prompt).toBe(
      'BASE_BRANCH_OVERRIDE=$BASE_BRANCH_OVERRIDE and BASE_BRANCH_PR=$BASE_BRANCH_PR'
    );
    expect(prompt).not.toContain('dev_OVERRIDE');
    expect(prompt).not.toContain('dev_PR');
  });

  // Test 2: exact $BASE_BRANCH still substitutes, including when followed by non-identifier chars.
  it('still substitutes exact $BASE_BRANCH when followed by a non-identifier char', () => {
    const { prompt } = substituteWorkflowVariables(
      'base=$BASE_BRANCH path=$BASE_BRANCH/x dot=$BASE_BRANCH. paren=$BASE_BRANCH)',
      'run-1',
      'msg',
      '/tmp',
      'dev',
      'docs/'
    );
    expect(prompt).toBe('base=dev path=dev/x dot=dev. paren=dev)');
  });

  // Test 3: every bounded $NAME variable is parametrized.
  it('bounds every $NAME workflow variable to whole identifiers (parametrized)', () => {
    // BASE_BRANCH coverage lives in Tests 1 + 2 above -- this parametrized
    // loop walks the other eight $NAME variables only.
    const cases = [
      { name: 'WORKFLOW_ID', value: 'WF1' },
      { name: 'USER_MESSAGE', value: 'UMSG' },
      { name: 'ARGUMENTS', value: 'UMSG' },
      { name: 'ARTIFACTS_DIR', value: '/art' },
      { name: 'DOCS_DIR', value: 'ds/' },
      { name: 'LOOP_USER_INPUT', value: 'LUI' },
      { name: 'REJECTION_REASON', value: 'RR' },
      { name: 'LOOP_PREV_OUTPUT', value: 'LPO' },
    ];
    for (const c of cases) {
      const name = c.name;
      const value = c.value;
      const expectedSuffix = '$' + name + '_SUFFIX';
      const promptTemplate = 'exact=$' + name + ' suffix=' + expectedSuffix;
      const { prompt } = substituteWorkflowVariables(
        promptTemplate,
        'WF1',
        'UMSG',
        '/art',
        'dev',
        'ds/',
        undefined,
        'LUI',
        'RR',
        'LPO'
      );
      expect(prompt).toBe('exact=' + value + ' suffix=' + expectedSuffix);
    }
  });

  // Test 4: empty-baseBranch guard is also bounded.
  it('does not throw the empty-base guard on prefix-longer $BASE_BRANCH_OVERRIDE', () => {
    expect(() =>
      substituteWorkflowVariables(
        'override=$BASE_BRANCH_OVERRIDE',
        'run-1',
        'msg',
        '/tmp',
        '',
        'docs/'
      )
    ).not.toThrow();
  });

  it('still throws the empty-base guard on exact $BASE_BRANCH', () => {
    expect(() =>
      substituteWorkflowVariables(
        'base=$BASE_BRANCH',
        'run-1',
        'msg',
        '/tmp',
        '',
        'docs/'
      )
    ).toThrow();
  });
