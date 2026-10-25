// Application dependencies are supplied per instance; evaluation has no screen effects.
function create(context, operations) {
  const { state, elements, services, environment, ui } = context;
  function setPromptHidden(hidden, persist = true) {
    hidden = !services.instructionsEnabled || hidden;
    operations.$('#prompt').hidden = hidden;
    operations.$('#promptToggle').setAttribute('aria-expanded', !hidden);
    if (services.instructionsEnabled && persist) {
      try {
        environment.localStorage.setItem(operations.PROMPT_KEY, hidden ? '1' : '');
      } catch {}
    }
    operations.resizePrompt();
  }
  function resizePrompt() {
    const input = operations.$('#promptInput');
    input.style.height = 'auto';
    input.style.height = Math.min(94, Math.max(46, input.scrollHeight || 46)) + 'px';
    environment.document.body.style.setProperty('--prompt-height', operations.$('.prompt').offsetHeight + 'px');
    operations.resizeNotices();
  }
  function resizeNotices() {
    const top = Math.max(72, operations.$('.topbar').getBoundingClientRect().bottom + 8);
    const banner = operations.$('#modeBanner');
    banner.style.top = top + 'px';
    environment.document.body.style.setProperty(
      '--notice-top',
      (banner.hidden ? top : top + banner.offsetHeight + 8) + 'px',
    );
  }
  function instructionToast(message, actions = [], transient = false, error = false) {
    context.timers.clear(context.timers.instruction);
    ui.instructionUndoButton = null;
    const t = operations.$('#instructionToast');
    t.textContent = message;
    t.hidden = false;
    t.setAttribute('role', error ? 'alert' : 'status');
    t.setAttribute('aria-live', error ? 'assertive' : 'polite');
    for (const action of actions) {
      const button = Object.assign(environment.document.createElement('button'), {
        className: 'btn',
        type: 'button',
        textContent: action.label,
      });
      button.onclick = action.run;
      t.append(button);
      if (action.undo) ui.instructionUndoButton = button;
    }
    if (!state.instruction) {
      const close = Object.assign(environment.document.createElement('button'), {
        className: 'btn',
        type: 'button',
        textContent: services.tr('common.close'),
      });
      close.onclick = () => {
        t.hidden = true;
      };
      t.append(close);
    }
    if (transient)
      context.timers.instruction = context.timers.set(() => {
        if (!state.instruction) t.hidden = true;
      }, 5000);
  }
  async function checkCodexStatus() {
    if (!services.instructionsEnabled) return;
    try {
      const status = await services.instructionClient.status();
      operations.$('#promptConnection').textContent = status.reason || '';
      operations.$('#promptConnection').hidden = status.available;
    } catch {
      operations.$('#promptConnection').textContent = services.tr('prompt.connection');
      operations.$('#promptConnection').hidden = false;
    }
  }
  function instructionConflict(run) {
    return (
      operations.mapRevisionConflict(run) ||
      !operations.OperationPolicy.canApplyInstruction(operations.operationState())
    );
  }
  function endInstruction(status, message, counts) {
    const run = state.instruction;
    if (!run) return;
    state.instruction = null;
    operations.$('#promptSend').disabled = false;
    operations.$('#promptSend').textContent = services.tr('prompt.send');
    operations.$('#promptQuestion').hidden = true;
    operations.$('#promptInput').placeholder = services.tr('prompt.placeholder');
    operations.$('#promptInput').setAttribute('aria-label', services.tr('prompt.label'));
    if (operations.$('#instructionDialog').open) operations.$('#instructionDialog').close();
    const input = operations.$('#promptInput'),
      actions = [];
    if (status === 'succeeded') {
      if (state.draftVersion === run.sentDraftVersion && input.value === run.sentText) {
        input.value = '';
        state.draftVersion++;
      }
      if (counts) {
        const token = state.historyToken;
        actions.push({
          label: services.tr('common.undo'),
          undo: true,
          run: () => {
            if (state.historyToken === token) {
              operations.undo();
              operations.$('#instructionToast').hidden = true;
            }
          },
        });
      }
    } else if (input.value !== run.text) {
      actions.push({
        label: services.tr('instruction.backToInput'),
        run: () => {
          input.value = run.text;
          state.draftVersion++;
          operations.resizePrompt();
          input.focus();
        },
      });
    }
    if (status === 'failed')
      actions.push({
        label: services.tr('instruction.retry'),
        run: () => {
          if (!state.instruction) void operations.sendInstruction(run.text);
        },
      });
    operations.instructionToast(
      message,
      actions,
      ['succeeded', 'cancelled', 'no_change'].includes(status),
      status === 'failed' || status === 'conflict',
    );
    operations.resizePrompt();
  }
  function cancelInstruction() {
    if (!state.instruction) return;
    // Invalidate the browser request before asking the relay to interrupt it.
    operations.endInstruction('cancelled', services.tr('instruction.cancelled'));
    services.instructionClient.cancel();
  }
  async function sendInstruction(retryText) {
    if (!services.instructionsEnabled) return;
    if (state.instruction?.state === 'awaiting_input' && typeof retryText !== 'string') {
      await operations.answerInstruction();
      return;
    }
    if (state.instruction) return;
    const text = typeof retryText === 'string' ? retryText : operations.$('#promptInput').value;
    if (!text.trim()) return;
    if (operations.readOnly()) {
      operations.instructionToast(services.tr('instruction.readOnly'), [], false, true);
      return;
    }
    if (!operations.OperationPolicy.canStartInstruction(operations.operationState())) return;
    if (state.editing) operations.finishEdit();
    operations.interruptHand();
    if (state.gesture) {
      operations.revertGesture();
      operations.pts.clear();
    }
    if (state.mode) operations.endReparent();
    const input = {
      requestId: services.InstructionTransport.id('req_'),
      clientSessionId: services.instructionClient.clientSessionId,
      mapSessionId: state.mapSessionId,
      baseRevision: state.revision,
      prompt: text,
      selectedNodeId: state.map.nodes[state.selectedId] ? state.selectedId : null,
      map: operations.serializeMap(),
    };
    try {
      services.InstructionOperations.validateInput(input);
      if (new TextEncoder().encode(JSON.stringify(input)).length > 1024 * 1024)
        throw new Error(services.tr('instruction.tooLarge'));
    } catch (error) {
      operations.instructionToast(error.message, [], false, true);
      return;
    }
    const run = (state.instruction = {
      id: input.requestId,
      session: state.mapSessionId,
      revision: state.revision,
      selection: state.selectedId,
      text,
      draftVersion: state.draftVersion,
      sentText: text,
      sentDraftVersion: state.draftVersion,
      state: 'thinking',
      snapshot: input.map,
    });
    operations.$('#promptSend').disabled = true;
    operations.instructionToast(services.tr('instruction.thinking'), [
      { label: services.tr('common.stop'), run: operations.cancelInstruction },
    ]);
    try {
      const proposal = await services.instructionClient.run(input, (status, data) => {
        if (state.instruction !== run) return;
        if (status === 'awaiting_input') {
          if (operations.instructionConflict(run)) {
            operations.endInstruction('conflict', services.tr('instruction.conflictQuestion'));
            services.instructionClient.cancel();
            return;
          }
          const field = operations.$('#promptInput');
          if (state.draftVersion === run.sentDraftVersion && field.value === run.sentText) {
            field.value = '';
            state.draftVersion++;
          }
          run.state = status;
          run.questionId = data.questionId;
          operations.$('#promptQuestion').textContent = data.message;
          operations.$('#promptQuestion').hidden = false;
          field.placeholder = services.tr('prompt.answerPlaceholder');
          field.setAttribute('aria-label', services.tr('prompt.answerLabel'));
          operations.setPromptHidden(false);
          operations.$('#promptSend').textContent = services.tr('prompt.answer');
          operations.$('#promptSend').disabled = false;
          operations.instructionToast(services.tr('instruction.waitingAnswer'), [
            { label: services.tr('common.stop'), run: operations.cancelInstruction },
          ]);
          operations.resizePrompt();
        } else if (status === 'thinking') {
          run.state = status;
          operations.$('#promptQuestion').hidden = true;
          operations.$('#promptSend').disabled = true;
          operations.instructionToast(services.tr('instruction.thinking'), [
            { label: services.tr('common.stop'), run: operations.cancelInstruction },
          ]);
          operations.resizePrompt();
        }
      });
      if (state.instruction !== run || services.instructionClient.applied.has(run.id)) return;
      if (operations.instructionConflict(run)) {
        operations.endInstruction('conflict', services.tr('instruction.conflictApply'));
        return;
      }
      services.InstructionOperations.validateProposal(proposal);
      if (proposal.status !== 'ok') {
        operations.endInstruction(
          proposal.status,
          proposal.message ||
            services.tr(proposal.status === 'no_change' ? 'instruction.noChange' : 'instruction.selectNode'),
        );
        return;
      }
      run.proposal = proposal;
      run.state = 'validating';
      run.prepared = services.InstructionOperations.prepare(run.snapshot, proposal, { size: operations.nodeSize });
      if (run.prepared.deletions.length) operations.confirmInstruction();
      else operations.applyInstruction();
    } catch (error) {
      if (state.instruction === run)
        operations.endInstruction('failed', error.message || services.tr('instruction.connectFailed'));
    }
  }
  async function answerInstruction() {
    const run = state.instruction,
      field = operations.$('#promptInput'),
      answer = field.value;
    if (!run || run.state !== 'awaiting_input' || !answer.trim()) return;
    if (operations.instructionConflict(run)) {
      operations.endInstruction('conflict', services.tr('instruction.conflictQuestion'));
      services.instructionClient.cancel();
      return;
    }
    const questionId = run.questionId;
    run.sentText = answer;
    run.sentDraftVersion = state.draftVersion;
    run.state = 'answering';
    operations.$('#promptSend').disabled = true;
    try {
      await services.instructionClient.answer(answer);
    } catch (error) {
      if (state.instruction !== run || run.questionId !== questionId || run.state !== 'answering') return;
      run.state = 'awaiting_input';
      operations.$('#promptSend').disabled = false;
      operations.instructionToast(
        error.message || services.tr('instruction.answerFailed'),
        [{ label: services.tr('common.stop'), run: operations.cancelInstruction }],
        false,
        true,
      );
    }
  }
  function confirmInstruction() {
    const run = state.instruction;
    run.state = 'awaiting_confirmation';
    const scopes = operations.$('#instructionScopes');
    scopes.textContent = '';
    run.proposal.operations.forEach((op, index) => {
      if (op.type !== 'delete_node') return;
      const row = environment.document.createElement('label');
      row.className = 'delete-option';
      const name = run.snapshot.nodes[op.nodeId]?.text || op.nodeId;
      const span = environment.document.createElement('span');
      span.textContent = services.tr('instruction.scopeOf', name);
      const select = environment.document.createElement('select');
      select.setAttribute('aria-label', services.tr('instruction.scopeOf', name));
      for (const [value, text] of [
        ['single', services.tr('instruction.scopeSingle')],
        ['subtree', services.tr('instruction.scopeSubtree')],
      ]) {
        const option = environment.document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.append(option);
      }
      select.value = op.scope;
      select.onchange = () => {
        run.proposal.operations[index].scope = select.value;
        operations.updateInstructionPreview();
      };
      row.append(span);
      row.append(select);
      scopes.append(row);
    });
    operations.updateInstructionPreview();
    operations.instructionToast(services.tr('instruction.review'), [
      { label: services.tr('common.stop'), run: operations.cancelInstruction },
    ]);
    operations.$('#instructionDialog').showModal();
    operations.$('#instructionCancel').focus();
  }
  function updateInstructionPreview() {
    const run = state.instruction;
    if (!run) return;
    try {
      run.prepared = services.InstructionOperations.prepare(run.snapshot, run.proposal, {
        size: operations.nodeSize,
      });
      operations.$('#instructionPreview').textContent =
        run.prepared.deletions
          .map(d =>
            services.tr(
              'instruction.previewItem',
              d.name,
              services.tr(d.scope === 'single' ? 'instruction.scopeSingle' : 'instruction.scopeSubtree'),
              d.count,
              d.names,
            ),
          )
          .join('\n\n') +
        '\n\n' +
        services.tr('instruction.total', services.InstructionOperations.summary(run.prepared.counts));
      operations.$('#instructionConfirm').disabled = false;
    } catch (error) {
      run.prepared = null;
      operations.$('#instructionPreview').textContent = error.message;
      operations.$('#instructionConfirm').disabled = true;
    }
  }
  function applyInstruction() {
    const run = state.instruction;
    if (!run || !run.prepared) return;
    if (operations.instructionConflict(run)) {
      operations.endInstruction('conflict', services.tr('instruction.conflictApply'));
      return;
    }
    const candidate = run.prepared;
    if (!candidate.changed) {
      operations.endInstruction('no_change', services.tr('instruction.noChange'));
      return;
    }
    let target = candidate.focusId,
      preserveView = false;
    if (state.selectedId !== run.selection) {
      preserveView = !!candidate.map.nodes[state.selectedId];
      target = state.selectedId;
      while (target && !candidate.map.nodes[target]) target = state.map.nodes[target]?.parent;
      target ||= candidate.map.root;
    }
    run.state = 'applying';
    operations.instructionToast(services.tr('instruction.applying'));
    // No await from the final revision check through publishing this one history entry.
    operations.commit(() => {
      state.map = candidate.map;
      operations.invalidateTree();
      state.selectedId = target;
    });
    services.instructionClient.applied.add(run.id);
    if (services.instructionClient.applied.size > 1000)
      services.instructionClient.applied.delete(services.instructionClient.applied.values().next().value);
    if (!preserveView) operations.ensureVisible(state.map.nodes[state.selectedId]);
    operations.endInstruction('succeeded', services.InstructionOperations.summary(candidate.counts), candidate.counts);
  }
  return {
    setPromptHidden,
    resizePrompt,
    resizeNotices,
    instructionToast,
    checkCodexStatus,
    instructionConflict,
    endInstruction,
    cancelInstruction,
    sendInstruction,
    answerInstruction,
    confirmInstruction,
    updateInstructionPreview,
    applyInstruction,
  };
}
export { create };
