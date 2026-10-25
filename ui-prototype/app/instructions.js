function setPromptHidden(hidden, persist = true) {
  hidden = !instructionsEnabled || hidden;
  $('#prompt').hidden = hidden;
  $('#promptToggle').setAttribute('aria-expanded', !hidden);
  if (instructionsEnabled && persist) {
    try {
      localStorage.setItem(PROMPT_KEY, hidden ? '1' : '');
    } catch {}
  }
  resizePrompt();
}
function resizePrompt() {
  const input = $('#promptInput');
  input.style.height = 'auto';
  input.style.height = Math.min(94, Math.max(46, input.scrollHeight || 46)) + 'px';
  document.body.style.setProperty('--prompt-height', $('.prompt').offsetHeight + 'px');
  resizeNotices();
}
function resizeNotices() {
  const top = Math.max(72, $('.topbar').getBoundingClientRect().bottom + 8);
  const banner = $('#modeBanner');
  banner.style.top = top + 'px';
  document.body.style.setProperty('--notice-top', (banner.hidden ? top : top + banner.offsetHeight + 8) + 'px');
}
function instructionToast(message, actions = [], transient = false, error = false) {
  clearTimeout(instructionTimer);
  instructionUndoButton = null;
  const t = $('#instructionToast');
  t.textContent = message;
  t.hidden = false;
  t.setAttribute('role', error ? 'alert' : 'status');
  t.setAttribute('aria-live', error ? 'assertive' : 'polite');
  for (const action of actions) {
    const button = Object.assign(document.createElement('button'), {
      className: 'btn',
      type: 'button',
      textContent: action.label,
    });
    button.onclick = action.run;
    t.append(button);
    if (action.undo) instructionUndoButton = button;
  }
  if (!state.instruction) {
    const close = Object.assign(document.createElement('button'), {
      className: 'btn',
      type: 'button',
      textContent: tr('common.close'),
    });
    close.onclick = () => {
      t.hidden = true;
    };
    t.append(close);
  }
  if (transient)
    instructionTimer = setTimeout(() => {
      if (!state.instruction) t.hidden = true;
    }, 5000);
}
async function checkCodexStatus() {
  if (!instructionsEnabled) return;
  try {
    const status = await instructionClient.status();
    $('#promptConnection').textContent = status.reason || '';
    $('#promptConnection').hidden = status.available;
  } catch {
    $('#promptConnection').textContent = tr('prompt.connection');
    $('#promptConnection').hidden = false;
  }
}
function instructionConflict(run) {
  return (
    run.session !== state.mapSessionId ||
    run.revision !== state.revision ||
    !!(state.editing || state.gesture || state.mode || state.deletion || state.hand?.grab)
  );
}
function endInstruction(status, message, counts) {
  const run = state.instruction;
  if (!run) return;
  state.instruction = null;
  $('#promptSend').disabled = false;
  $('#promptSend').textContent = tr('prompt.send');
  $('#promptQuestion').hidden = true;
  $('#promptInput').placeholder = tr('prompt.placeholder');
  $('#promptInput').setAttribute('aria-label', tr('prompt.label'));
  if ($('#instructionDialog').open) $('#instructionDialog').close();
  const input = $('#promptInput'),
    actions = [];
  if (status === 'succeeded') {
    if (state.draftVersion === run.sentDraftVersion && input.value === run.sentText) {
      input.value = '';
      state.draftVersion++;
    }
    if (counts) {
      const token = state.historyToken;
      actions.push({
        label: tr('common.undo'),
        undo: true,
        run: () => {
          if (state.historyToken === token) {
            undo();
            $('#instructionToast').hidden = true;
          }
        },
      });
    }
  } else if (input.value !== run.text) {
    actions.push({
      label: tr('instruction.backToInput'),
      run: () => {
        input.value = run.text;
        state.draftVersion++;
        resizePrompt();
        input.focus();
      },
    });
  }
  if (status === 'failed')
    actions.push({
      label: tr('instruction.retry'),
      run: () => {
        if (!state.instruction) void sendInstruction(run.text);
      },
    });
  instructionToast(
    message,
    actions,
    ['succeeded', 'cancelled', 'no_change'].includes(status),
    status === 'failed' || status === 'conflict',
  );
  resizePrompt();
}
function cancelInstruction() {
  if (!state.instruction) return;
  // Invalidate the browser request before asking the relay to interrupt it.
  endInstruction('cancelled', tr('instruction.cancelled'));
  instructionClient.cancel();
}
async function sendInstruction(retryText) {
  if (!instructionsEnabled) return;
  if (state.instruction?.state === 'awaiting_input' && typeof retryText !== 'string') {
    await answerInstruction();
    return;
  }
  if (state.instruction) return;
  const text = typeof retryText === 'string' ? retryText : $('#promptInput').value;
  if (!text.trim()) return;
  if (readOnly()) {
    instructionToast(tr('instruction.readOnly'), [], false, true);
    return;
  }
  if (state.deletion || $('#instructionDialog').open) return;
  if (state.editing) finishEdit();
  interruptHand();
  if (state.gesture) {
    revertGesture();
    pts.clear();
  }
  if (state.mode) endReparent();
  const input = {
    requestId: InstructionTransport.id('req_'),
    clientSessionId: instructionClient.clientSessionId,
    mapSessionId: state.mapSessionId,
    baseRevision: state.revision,
    prompt: text,
    selectedNodeId: state.map.nodes[state.selectedId] ? state.selectedId : null,
    map: serializeMap(),
  };
  try {
    InstructionOperations.validateInput(input);
    if (new TextEncoder().encode(JSON.stringify(input)).length > 1024 * 1024)
      throw new Error(tr('instruction.tooLarge'));
  } catch (error) {
    instructionToast(error.message, [], false, true);
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
  $('#promptSend').disabled = true;
  instructionToast(tr('instruction.thinking'), [{ label: tr('common.stop'), run: cancelInstruction }]);
  try {
    const proposal = await instructionClient.run(input, (status, data) => {
      if (state.instruction !== run) return;
      if (status === 'awaiting_input') {
        if (instructionConflict(run)) {
          endInstruction('conflict', tr('instruction.conflictQuestion'));
          instructionClient.cancel();
          return;
        }
        const field = $('#promptInput');
        if (state.draftVersion === run.sentDraftVersion && field.value === run.sentText) {
          field.value = '';
          state.draftVersion++;
        }
        run.state = status;
        run.questionId = data.questionId;
        $('#promptQuestion').textContent = data.message;
        $('#promptQuestion').hidden = false;
        field.placeholder = tr('prompt.answerPlaceholder');
        field.setAttribute('aria-label', tr('prompt.answerLabel'));
        setPromptHidden(false);
        $('#promptSend').textContent = tr('prompt.answer');
        $('#promptSend').disabled = false;
        instructionToast(tr('instruction.waitingAnswer'), [{ label: tr('common.stop'), run: cancelInstruction }]);
        resizePrompt();
      } else if (status === 'thinking') {
        run.state = status;
        $('#promptQuestion').hidden = true;
        $('#promptSend').disabled = true;
        instructionToast(tr('instruction.thinking'), [{ label: tr('common.stop'), run: cancelInstruction }]);
        resizePrompt();
      }
    });
    if (state.instruction !== run || instructionClient.applied.has(run.id)) return;
    if (instructionConflict(run)) {
      endInstruction('conflict', tr('instruction.conflictApply'));
      return;
    }
    InstructionOperations.validateProposal(proposal);
    if (proposal.status !== 'ok') {
      endInstruction(
        proposal.status,
        proposal.message || tr(proposal.status === 'no_change' ? 'instruction.noChange' : 'instruction.selectNode'),
      );
      return;
    }
    run.proposal = proposal;
    run.state = 'validating';
    run.prepared = InstructionOperations.prepare(run.snapshot, proposal, { size: nodeSize });
    if (run.prepared.deletions.length) confirmInstruction();
    else applyInstruction();
  } catch (error) {
    if (state.instruction === run) endInstruction('failed', error.message || tr('instruction.connectFailed'));
  }
}
async function answerInstruction() {
  const run = state.instruction,
    field = $('#promptInput'),
    answer = field.value;
  if (!run || run.state !== 'awaiting_input' || !answer.trim()) return;
  if (instructionConflict(run)) {
    endInstruction('conflict', tr('instruction.conflictQuestion'));
    instructionClient.cancel();
    return;
  }
  const questionId = run.questionId;
  run.sentText = answer;
  run.sentDraftVersion = state.draftVersion;
  run.state = 'answering';
  $('#promptSend').disabled = true;
  try {
    await instructionClient.answer(answer);
  } catch (error) {
    if (state.instruction !== run || run.questionId !== questionId || run.state !== 'answering') return;
    run.state = 'awaiting_input';
    $('#promptSend').disabled = false;
    instructionToast(
      error.message || tr('instruction.answerFailed'),
      [{ label: tr('common.stop'), run: cancelInstruction }],
      false,
      true,
    );
  }
}
function confirmInstruction() {
  const run = state.instruction;
  run.state = 'awaiting_confirmation';
  const scopes = $('#instructionScopes');
  scopes.textContent = '';
  run.proposal.operations.forEach((op, index) => {
    if (op.type !== 'delete_node') return;
    const row = document.createElement('label');
    row.className = 'delete-option';
    const name = run.snapshot.nodes[op.nodeId]?.text || op.nodeId;
    const span = document.createElement('span');
    span.textContent = tr('instruction.scopeOf', name);
    const select = document.createElement('select');
    select.setAttribute('aria-label', tr('instruction.scopeOf', name));
    for (const [value, text] of [
      ['single', tr('instruction.scopeSingle')],
      ['subtree', tr('instruction.scopeSubtree')],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = op.scope;
    select.onchange = () => {
      run.proposal.operations[index].scope = select.value;
      updateInstructionPreview();
    };
    row.append(span);
    row.append(select);
    scopes.append(row);
  });
  updateInstructionPreview();
  instructionToast(tr('instruction.review'), [{ label: tr('common.stop'), run: cancelInstruction }]);
  $('#instructionDialog').showModal();
  $('#instructionCancel').focus();
}
function updateInstructionPreview() {
  const run = state.instruction;
  if (!run) return;
  try {
    run.prepared = InstructionOperations.prepare(run.snapshot, run.proposal, { size: nodeSize });
    $('#instructionPreview').textContent =
      run.prepared.deletions
        .map(d =>
          tr(
            'instruction.previewItem',
            d.name,
            tr(d.scope === 'single' ? 'instruction.scopeSingle' : 'instruction.scopeSubtree'),
            d.count,
            d.names,
          ),
        )
        .join('\n\n') +
      '\n\n' +
      tr('instruction.total', InstructionOperations.summary(run.prepared.counts));
    $('#instructionConfirm').disabled = false;
  } catch (error) {
    run.prepared = null;
    $('#instructionPreview').textContent = error.message;
    $('#instructionConfirm').disabled = true;
  }
}
function applyInstruction() {
  const run = state.instruction;
  if (!run || !run.prepared) return;
  if (instructionConflict(run)) {
    endInstruction('conflict', tr('instruction.conflictApply'));
    return;
  }
  const candidate = run.prepared;
  if (!candidate.changed) {
    endInstruction('no_change', tr('instruction.noChange'));
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
  instructionToast(tr('instruction.applying'));
  // No await from the final revision check through publishing this one history entry.
  commit(() => {
    state.map = candidate.map;
    invalidateTree();
    state.selectedId = target;
  });
  instructionClient.applied.add(run.id);
  if (instructionClient.applied.size > 1000)
    instructionClient.applied.delete(instructionClient.applied.values().next().value);
  if (!preserveView) ensureVisible(state.map.nodes[state.selectedId]);
  endInstruction('succeeded', InstructionOperations.summary(candidate.counts), candidate.counts);
}
