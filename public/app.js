'use strict';

(function () {
  const state = {
    configured: false,
    currentView: 'board',
    wizardStep: 1,
    connectionTestPassed: false,
    config: null,
    board: null,
    overview: null,
    monthlyReport: null,
    logs: [],
    selectedTickets: new Set(),
    pendingBulkAction: null,
    sse: null,
    boardFilters: {
      search: '',
      periodMode: 'all', // 'all' | 'day' | 'month' | 'year'
      day: '',
      month: '',
      year: ''
    }
  };

  // Utilidad segura para crear elementos DOM usando exclusivamente textContent (nunca innerHTML para datos externos)
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'className') node.className = v;
      else if (k === 'textContent') node.textContent = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (typeof v === 'boolean') {
        if (v) node.setAttribute(k, '');
        node[k] = v;
      } else {
        node.setAttribute(k, String(v));
      }
    }
    for (const child of children) {
      if (child === null || child === undefined) continue;
      if (typeof child === 'string' || typeof child === 'number') {
        node.appendChild(document.createTextNode(String(child)));
      } else {
        node.appendChild(child);
      }
    }
    return node;
  }

  function showToast(msg, type = 'ok', durationMs = 4000) {
    const container = document.getElementById('toastContainer');
    const item = el('div', { className: `toast ${type}`, textContent: msg });
    container.appendChild(item);
    setTimeout(() => item.remove(), durationMs);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.pinRequired) {
      document.getElementById('pinModalBackdrop').classList.remove('hidden');
      throw new Error(data.error || 'PIN requerido');
    }
    if (!res.ok) {
      throw new Error(data.error || `Error HTTP ${res.status}`);
    }
    return data;
  }

  // Tema claro/oscuro sin parpadeo
  function toggleTheme() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('panel_reparto_theme', next);
    } catch {}
  }

  function getInitials(name = '') {
    const parts = String(name || 'U')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length === 0) return 'U';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Crea nodo de foto de perfil seguro con iniciales de respaldo
  function createAvatarNode(name, fotoUrl, sizeClass = '') {
    const initials = getInitials(name);
    const wrap = el('div', {
      className: `user-avatar ${sizeClass}`.trim(),
      title: name || 'Usuario'
    });
    if (fotoUrl && (/^https?:\/\//i.test(fotoUrl) || /^data:image\//i.test(fotoUrl))) {
      const img = el('img', { src: fotoUrl, alt: name || 'Foto' });
      img.addEventListener('error', () => {
        wrap.replaceChildren(document.createTextNode(initials));
      });
      wrap.appendChild(img);
    } else {
      wrap.textContent = initials;
    }
    return wrap;
  }

  // Crea etiqueta visual de estado en línea / ausente / desconectado
  function createOnlineBadge(advisor) {
    if (advisor.online === true) {
      return el('span', { className: 'online-pill online', textContent: '● En línea' });
    }
    if (advisor.away) {
      const reason = advisor.away.reason ? `: ${advisor.away.reason}` : '';
      return el('span', {
        className: 'online-pill away',
        title: `Ausente${reason}`,
        textContent: '◆ Ausente'
      });
    }
    if (advisor.online === false) {
      const label =
        advisor.whaticketStatus === 'seatless'
          ? '○ Sin puesto'
          : advisor.whaticketStatus === 'pending'
          ? '○ Conectando'
          : '○ Desconectado';
      return el('span', { className: 'online-pill offline', textContent: label });
    }
    return el('span', {
      className: 'online-pill offline',
      title: 'Estado en línea disponible si el token tiene el permiso users:view en Whaticket',
      textContent: advisor.disponible ? '● Activo panel' : '○ Pausado'
    });
  }

  // Botón clicable sobre el nombre de cualquier usuario para abrir el modal de sus tickets y su cantidad diaria en grande
  function createClickableUserName(name, userId, dateStr = null) {
    if (!userId) {
      return el('strong', { textContent: name || 'Sin nombre' });
    }
    return el('button', {
      type: 'button',
      className: 'clickable-user-name',
      title: 'Clic para ver los tickets asignados a este usuario y su cantidad diaria en grande',
      textContent: name || 'Asesor',
      onClick: () => openUserTicketsModal(String(userId), dateStr)
    });
  }

  let currentModalUserId = null;

  async function openUserTicketsModal(userId, dateStr = null) {
    currentModalUserId = String(userId);
    const dateInp = document.getElementById('userModalDateInput');
    const targetDate = dateStr || dateInp.value || state.boardFilters.day || toLocalDayStr(new Date().toISOString());
    dateInp.value = targetDate;
    document.getElementById('userTicketsModalBackdrop').classList.remove('hidden');

    try {
      const data = await api(
        `/api/user-tickets?userId=${encodeURIComponent(currentModalUserId)}&date=${encodeURIComponent(targetDate)}`
      );
      renderUserTicketsModal(data);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderUserTicketsModal(data) {
    const adv = data.advisor || {};
    const headerInfo = document.getElementById('userTicketsModalHeaderInfo');
    headerInfo.replaceChildren(
      createAvatarNode(adv.nombre, adv.fotoPerfil, 'lg'),
      el('div', {}, [
        el('h3', {
          id: 'userTicketsModalTitle',
          className: 'modal-title',
          style: { margin: 0 },
          textContent: adv.nombre || 'Usuario'
        }),
        el('div', { style: { display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' } }, [
          el('span', { className: 'badge', textContent: `${adv.tipo || 'Digital'} · Nivel ${adv.nivel || 1}` }),
          createOnlineBadge({
            online: adv.online,
            away: adv.away,
            whaticketStatus: adv.whaticketStatus,
            disponible: true
          })
        ])
      ])
    );

    document.getElementById('userModalDayLabel').textContent = `Asignados el día (${data.selectedDate})`;
    document.getElementById('userModalBigDayCount').textContent = String(data.assignedOnDateCount ?? 0);
    document.getElementById('userModalBigActiveCount').textContent = `${
      data.activeTicketsCount ?? 0
    } / ${adv.topeMaximo || 15}`;
    document.getElementById('userModalBigUnansweredCount').textContent = String(
      adv.unansweredCount ?? 0
    );

    const tbodyActive = document.getElementById('tbodyUserModalActive');
    tbodyActive.replaceChildren();
    const activeList = data.activeTickets || [];
    if (activeList.length === 0) {
      tbodyActive.appendChild(
        el('tr', {}, [
          el('td', {
            colSpan: 5,
            className: 'empty-state',
            textContent: 'Este usuario no tiene tickets abiertos/pendientes en este momento.'
          })
        ])
      );
    } else {
      for (const t of activeList) {
        const semIcon =
          t.semaphore === 'rojo' ? '▲ Rojo' : t.semaphore === 'amarillo' ? '◆ Amarillo' : '● Verde';
        tbodyActive.appendChild(
          el('tr', {}, [
            el('td', {}, [
              el('div', { className: 'contact-name', textContent: t.contact?.name || 'Sin nombre' }),
              el('div', { className: 'contact-number', textContent: t.contact?.number || '' })
            ]),
            el('td', {}, [
              el('span', { className: 'badge badge-channel', textContent: t.channel || 'whatsapp' })
            ]),
            el('td', {}, [
              t.hasNoDepartment
                ? el('span', { className: 'badge badge-no-dept', textContent: '⚠ Sin dpto.' })
                : el('span', { className: 'badge', textContent: t.departmentName || 'Dpto.' })
            ]),
            el('td', {}, [
              el('div', {
                className: 'msg-preview',
                textContent: t.lastMessagePreview || '(Sin texto)'
              })
            ]),
            el('td', {}, [
              el('span', {
                className: `chip-semaforo ${t.semaphore}`,
                textContent: `${semIcon} · ${t.elapsedMinutes} min`
              })
            ])
          ])
        );
      }
    }

    const tbodyDay = document.getElementById('tbodyUserModalDayEvents');
    tbodyDay.replaceChildren();
    const dayEvents = data.dayEvents || [];
    if (dayEvents.length === 0) {
      tbodyDay.appendChild(
        el('tr', {}, [
          el('td', {
            colSpan: 5,
            className: 'empty-state',
            textContent: `Sin tickets registrados para ${adv.nombre} en la fecha ${data.selectedDate}.`
          })
        ])
      );
    } else {
      for (const ev of dayEvents) {
        tbodyDay.appendChild(
          el('tr', {}, [
            el('td', { textContent: new Date(ev.fechaHora).toLocaleTimeString('es-CO') }),
            el('td', { textContent: ev.clienteNombre || '-' }),
            el('td', { textContent: ev.clienteNumero || '-' }),
            el('td', { textContent: ev.ticketId }),
            el('td', {
              textContent: ev.origenLabel + (ev.simulado ? ' (Simulación)' : '')
            })
          ])
        );
      }
    }

    const pillsBox = document.getElementById('userModalDailyPills');
    pillsBox.replaceChildren();
    const breakdown = data.dailyBreakdown || [];
    if (breakdown.length === 0) {
      pillsBox.appendChild(
        el('span', {
          className: 'contact-number',
          textContent: `Sin registros en el mes ${data.month}.`
        })
      );
    } else {
      for (const item of breakdown) {
        const isCurrent = item.day === data.selectedDate;
        const pillBtn = el('button', {
          type: 'button',
          className: 'btn btn-sm' + (isCurrent ? ' btn-primary' : ''),
          textContent: `${item.day}: ${item.count} ticket(s)`,
          onClick: () => openUserTicketsModal(currentModalUserId, item.day)
        });
        pillsBox.appendChild(pillBtn);
      }
    }
  }

  // Selector de foto de perfil (permite subir archivo redimensionado a 96x96 o pegar URL)
  function openPhotoPickerForAdvisor(currentPhoto, onPicked) {
    const fileInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp,image/gif',
      className: 'hidden'
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const size = 96;
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          const minSide = Math.min(img.width, img.height);
          const sx = (img.width - minSide) / 2;
          const sy = (img.height - minSide) / 2;
          ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          onPicked(dataUrl);
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
    document.body.appendChild(fileInput);
    fileInput.click();
    setTimeout(() => fileInput.remove(), 60000);
  }

  // Navegación de vistas
  function switchView(viewName) {
    state.currentView = viewName;
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    const wizardSec = document.getElementById('wizardSection');
    const emptySec = document.getElementById('unconfiguredEmptyState');
    const views = {
      board: document.getElementById('viewBoard'),
      overview: document.getElementById('viewOverview'),
      reports: document.getElementById('viewReports'),
      advisors: document.getElementById('viewAdvisors'),
      history: document.getElementById('viewHistory'),
      settings: document.getElementById('viewSettings')
    };

    Object.values(views).forEach((v) => v && v.classList.add('hidden'));
    wizardSec.classList.add('hidden');
    emptySec.classList.add('hidden');

    if (!state.configured && viewName !== 'wizard') {
      emptySec.classList.remove('hidden');
      return;
    }

    if (viewName === 'wizard') {
      wizardSec.classList.remove('hidden');
      renderWizardStep(state.wizardStep);
      return;
    }

    if (views[viewName]) {
      views[viewName].classList.remove('hidden');
    }

    if (viewName === 'overview') {
      populateUserFilterSelects();
      loadOverview();
    } else if (viewName === 'reports') {
      populateUserFilterSelects();
      loadMonthlyReport();
    } else if (viewName === 'history') {
      loadHistoryLogs();
    } else if (viewName === 'settings') {
      renderSettingsOverview();
    }
  }

  // --- ASISTENTE DE CONFIGURACIÓN (4 PASOS) ---
  function renderWizardStep(step) {
    state.wizardStep = step;
    for (let i = 1; i <= 4; i++) {
      const pill = document.getElementById(`stepPill${i}`);
      const panel = document.getElementById(`wizardStep${i}`);
      pill.classList.toggle('active', i === step);
      pill.classList.toggle('done', i < step);
      panel.classList.toggle('hidden', i !== step);
    }

    if (state.config) {
      document.getElementById('wizBaseUrl').value =
        state.config.apiBaseUrl || 'https://api.whaticket.com/api/v1';
      const tokenHint = document.getElementById('wizSavedTokenHint');
      if (state.config.token?.configurado) {
        tokenHint.textContent = `Token guardado actualmente: ${state.config.token.ultimos4}. Déjalo en blanco para conservarlo o escribe uno nuevo.`;
        tokenHint.classList.remove('hidden');
        document.getElementById('btnWizNext1').disabled = false;
      } else {
        tokenHint.classList.add('hidden');
      }

      document.getElementById('wizGreenMin').value = state.config.thresholds?.greenMaxMin ?? 5;
      document.getElementById('wizYellowMin').value = state.config.thresholds?.yellowMaxMin ?? 15;
      document.getElementById('wizUnansweredMin').value = state.config.unansweredMin ?? 5;
      document.getElementById('wizProtectionMin').value = state.config.protectionMin ?? 3;
      document.getElementById('wizPollingSec').value = state.config.pollingSec ?? 20;
      document.getElementById('wizDefaultMode').value = state.config.defaultMode || 'least_load';
      document.getElementById('wizDryRun').checked = Boolean(state.config.dryRun);
      document.getElementById('wizAutoAssignEnabled').checked = Boolean(
        state.config.autoAssign?.enabled
      );
      document.getElementById('wizAutoMinWait').value =
        state.config.autoAssign?.minWaitMin ?? 0;
      document.getElementById('wizAutoType').value =
        state.config.autoAssign?.advisorType || 'all';
      document.getElementById('wizAutoOnlyOnline').checked =
        state.config.autoAssign?.onlyOnline !== false;
    }

    if (step === 2) {
      renderWizardAdvisorsTable();
    } else if (step === 4) {
      renderWizardSummary();
    }
  }

  function renderWizardAdvisorsTable() {
    const tbody = document.getElementById('wizAdvisorsTbody');
    tbody.replaceChildren();
    const advisors = state.config?.advisors || [];
    const deptsContainer = document.getElementById('wizDepartmentsList');
    deptsContainer.replaceChildren();

    for (const d of state.config?.departments || []) {
      deptsContainer.appendChild(
        el('span', { className: 'badge', textContent: `${d.name}` })
      );
    }

    const supSelect = document.getElementById('wizSupervisorSelect');
    supSelect.replaceChildren();
    supSelect.appendChild(el('option', { value: '', textContent: '-- Seleccionar supervisor --' }));

    for (const a of advisors) {
      const opt = el('option', {
        value: a.whaticket_user_id,
        textContent: `${a.nombre_visible} (${a.tipo})`
      });
      if (String(state.config?.supervisorUserId) === String(a.whaticket_user_id)) {
        opt.selected = true;
      }
      supSelect.appendChild(opt);

      const chkInc = el('input', { type: 'checkbox', checked: Boolean(a.incluido) });
      chkInc.addEventListener('change', () => {
        a.incluido = chkInc.checked;
      });

      const inpName = el('input', {
        type: 'text',
        className: 'input input-sm',
        value: a.nombre_visible
      });
      inpName.addEventListener('input', () => {
        a.nombre_visible = inpName.value;
      });

      const selTipo = el('select', { className: 'select select-sm' }, [
        el('option', { value: 'Digital', textContent: 'Digital', selected: a.tipo === 'Digital' }),
        el('option', { value: 'Sala', textContent: 'Sala', selected: a.tipo === 'Sala' })
      ]);
      selTipo.addEventListener('change', () => {
        a.tipo = selTipo.value;
      });

      const chkDisp = el('input', { type: 'checkbox', checked: Boolean(a.disponible) });
      chkDisp.addEventListener('change', () => {
        a.disponible = chkDisp.checked;
      });

      const inpTope = el('input', {
        type: 'number',
        min: 1,
        max: 200,
        className: 'input input-sm',
        style: { width: '68px' },
        value: a.tope_maximo || 15
      });
      inpTope.addEventListener('input', () => {
        a.tope_maximo = Number(inpTope.value) || 15;
      });

      const inpPeso = el('input', {
        type: 'number',
        min: 1,
        max: 20,
        className: 'input input-sm',
        style: { width: '64px' },
        value: a.nivel || a.peso || 1,
        title: 'Nivel para turnos por nivel (ej. Nivel 1 = 1 turno por ciclo, Nivel 2 = 2 turnos intercalados)'
      });
      inpPeso.addEventListener('input', () => {
        a.peso = Math.max(1, Number(inpPeso.value) || 1);
        a.nivel = a.peso;
      });

      const avatarCell = el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
        createAvatarNode(a.nombre_visible, a.foto_url, 'sm'),
        el('button', {
          type: 'button',
          className: 'btn btn-sm',
          textContent: 'Foto',
          onClick: () => {
            openPhotoPickerForAdvisor(a.foto_url, (dataUrl) => {
              a.foto_url = dataUrl;
              renderWizardAdvisorsTable();
            });
          }
        })
      ]);

      const tr = el('tr', {}, [
        el('td', {}, [chkInc]),
        el('td', {}, [avatarCell]),
        el('td', {}, [inpName]),
        el('td', {}, [selTipo]),
        el('td', {}, [chkDisp]),
        el('td', {}, [inpTope]),
        el('td', {}, [inpPeso])
      ]);
      tbody.appendChild(tr);
    }

    if (advisors.length === 0) {
      tbody.appendChild(
        el('tr', {}, [
          el('td', {
            colSpan: 7,
            className: 'empty-state',
            textContent: 'No hay asesores cargados aún. Usa "Volver a importar" o añade uno por UUID abajo.'
          })
        ])
      );
    }
  }

  function renderWizardSummary() {
    const box = document.getElementById('wizSummaryContent');
    box.replaceChildren();
    const cfg = state.config || {};
    const included = (cfg.advisors || []).filter((a) => a.incluido);
    const modeVal = document.getElementById('wizDefaultMode').value;
    const modeLabel =
      modeVal === 'weighted'
        ? 'Turnos por Nivel (uno a la vez)'
        : modeVal === 'round_robin'
        ? 'Turnos simples (Round-Robin)'
        : 'Menor carga';
    const autoOn = document.getElementById('wizAutoAssignEnabled').checked;
    const lines = [
      `URL Base API: ${cfg.apiBaseUrl || 'https://api.whaticket.com/api/v1'}`,
      `Token API: ${cfg.token?.ultimos4 || 'Configurado'}`,
      `Asesores incluidos: ${included.length} (${included.filter((a) => a.tipo === 'Digital').length} Digital, ${included.filter((a) => a.tipo === 'Sala').length} Sala)`,
      `Departamentos importados: ${(cfg.departments || []).length}`,
      `Modo de reparto por defecto: ${modeLabel} | Reparto automático: ${autoOn ? 'ACTIVO' : 'Inactivo'}`,
      `Semáforo: Verde < ${document.getElementById('wizGreenMin').value} min | Amarillo hasta ${document.getElementById('wizYellowMin').value} min`,
      `Sin responder: > ${document.getElementById('wizUnansweredMin').value} min | Protección: ${document.getElementById('wizProtectionMin').value} min`,
      `Modo simulación (DRY_RUN): ${document.getElementById('wizDryRun').checked ? 'ACTIVO (seguro)' : 'DESACTIVADO (producción)'}`
    ];
    for (const l of lines) {
      box.appendChild(el('div', { textContent: `• ${l}` }));
    }
  }

  function toLocalDayStr(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Filtra una lista de tickets del tablero por texto (nombre/teléfono de cliente o usuario) y por día/mes/año
  function filterBoardTickets(tickets = []) {
    const q = String(state.boardFilters.search || '').trim().toLowerCase();
    const mode = state.boardFilters.periodMode || 'all';
    const targetDay = state.boardFilters.day;
    const targetMonth = state.boardFilters.month;
    const targetYear = String(state.boardFilters.year || '').trim();

    return tickets.filter((t) => {
      if (q) {
        const hay = [
          t.contact?.name || '',
          t.contact?.number || '',
          t.advisorName || '',
          t.departmentName || '',
          t.lastMessagePreview || ''
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }

      if (mode !== 'all') {
        const refIso = t.lastMessageAt || t.updatedAt || t.createdAt;
        const dayStr = toLocalDayStr(refIso);
        if (!dayStr) return false;
        if (mode === 'day' && targetDay && dayStr !== targetDay) return false;
        if (mode === 'month' && targetMonth && !dayStr.startsWith(targetMonth)) return false;
        if (mode === 'year' && targetYear && !dayStr.startsWith(targetYear)) return false;
      }
      return true;
    });
  }

  // Renderiza la tira de usuarios en tiempo real dentro del Tablero
  function renderBoardAdvisorsStrip(advisors = []) {
    const strip = document.getElementById('boardAdvisorsStrip');
    if (!strip) return;
    strip.replaceChildren();

    const q = String(state.boardFilters.search || '').trim().toLowerCase();
    const filteredAdvisors = q
      ? advisors.filter((a) => String(a.nombre_visible || '').toLowerCase().includes(q))
      : advisors;
    const listToShow = filteredAdvisors.length > 0 ? filteredAdvisors : advisors;

    const onlineAdvisors = advisors.filter((a) => a.online === true);
    const unansweredOnlineTotal = onlineAdvisors.reduce(
      (sum, a) => sum + Number(a.unansweredCount || 0),
      0
    );
    const unansweredAllAdvisors = advisors.reduce(
      (sum, a) => sum + Number(a.unansweredCount || 0),
      0
    );

    const onlineBadge = document.getElementById('onlineSummaryBadge');
    const onlineUnansBadge = document.getElementById('onlineUnansweredBadge');
    const kpiSub = document.getElementById('kpiOnlineSubtext');

    if (onlineBadge) {
      onlineBadge.textContent = `${onlineAdvisors.length} de ${advisors.length} en línea`;
    }
    if (onlineUnansBadge) {
      onlineUnansBadge.textContent =
        onlineAdvisors.length > 0
          ? `${unansweredOnlineTotal} sin responder (enusuarios en línea)`
          : `${unansweredAllAdvisors} sin responder (total asignados)`;
    }
    if (kpiSub) {
      kpiSub.textContent = `En línea: ${onlineAdvisors.length} · Sin resp. en línea: ${
        onlineAdvisors.length > 0 ? unansweredOnlineTotal : unansweredAllAdvisors
      }`;
    }

    if (listToShow.length === 0) {
      strip.appendChild(
        el('div', {
          className: 'card empty-state',
          textContent: 'No hay asesores configurados.'
        })
      );
      return;
    }

    for (const a of listToShow) {
      const avatar = createAvatarNode(a.nombre_visible, a.fotoPerfil || a.foto_url);
      avatar.style.cursor = 'pointer';
      avatar.title = 'Clic para cambiar foto de perfil';
      avatar.addEventListener('click', () => {
        openPhotoPickerForAdvisor(a.fotoPerfil || a.foto_url, async (dataUrl) => {
          try {
            const res = await api(`/api/advisors/${a.id}`, {
              method: 'PATCH',
              body: { foto_url: dataUrl }
            });
            state.board = res.board;
            renderBoard();
            showToast(`Foto de ${a.nombre_visible} actualizada.`);
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      });

      const mini = el('div', { className: 'board-advisor-mini' }, [
        avatar,
        el('div', { className: 'board-advisor-mini-info' }, [
          el('div', { className: 'board-advisor-mini-top' }, [
            createClickableUserName(a.nombre_visible, a.whaticket_user_id),
            createOnlineBadge(a)
          ]),
          el('div', { className: 'board-advisor-mini-metrics' }, [
            el('span', {
              className: 'badge',
              textContent: `Hoy: ${a.assignedToday || 0}`
            }),
            el('span', {
              className: 'badge',
              textContent: `Activos: ${a.currentLoad || 0}/${a.tope_maximo}`
            }),
            el('span', {
              className:
                'badge' + ((a.unansweredCount || 0) > 0 ? ' badge-no-dept' : ''),
              textContent: `Sin resp.: ${a.unansweredCount || 0}`
            }),
            el('span', {
              className: 'badge',
              textContent: `Nivel: ${a.nivel || a.peso || 1}`
            })
          ])
        ])
      ]);
      strip.appendChild(mini);
    }
  }

  // --- RENDERIZADO DEL TABLERO ---
  function renderBoard() {
    const board = state.board;
    if (!board) return;

    // Banners superiores
    document.getElementById('dryRunBanner').classList.toggle('hidden', !board.dryRun);
    const hasAuthErr = Boolean(board.connection?.authInvalid);
    document.getElementById('authErrorBanner').classList.toggle('hidden', !hasAuthErr);
    if (hasAuthErr && board.connection?.lastErrorMessage) {
      document.getElementById('authErrorText').textContent = board.connection.lastErrorMessage;
    }

    // Estado de conexión en el header
    const dot = document.getElementById('connDot');
    const connTxt = document.getElementById('connStatusText');
    dot.className = 'conn-dot ' + (board.connection?.ok ? 'ok' : 'err');
    connTxt.textContent = board.connection?.ok
      ? board.dryRun
        ? 'Conectado (Simulación)'
        : 'Conectado a Whaticket'
      : board.connection?.lastErrorMessage || 'Sin conexión';

    const dt = board.lastUpdatedAt ? new Date(board.lastUpdatedAt) : new Date();
    document.getElementById('lastUpdatedText').textContent =
      'Últ. act.: ' + dt.toLocaleTimeString('es-CO');

    // Sincronizar modo de reparto y check de auto-asignación
    const distSelect = document.getElementById('boardDistMode');
    if (distSelect && !distSelect.dataset.userChanged && board.defaultMode) {
      distSelect.value = board.defaultMode;
    }
    const chkAuto = document.getElementById('chkBoardAutoAssign');
    if (chkAuto) {
      chkAuto.checked = Boolean(board.autoAssign?.enabled);
    }

    // KPIs
    document.getElementById('kpiWaiting').textContent = String(board.kpis?.enEspera ?? 0);
    document.getElementById('kpiUnanswered').textContent = String(board.kpis?.sinResponder ?? 0);
    document.getElementById('kpiCritical').textContent = String(board.kpis?.criticosRojo ?? 0);
    document.getElementById('kpiAdvisors').textContent = `${
      board.kpis?.asesoresDisponibles ?? 0
    } / ${board.kpis?.totalAsesores ?? 0}`;

    // Renderizar tira de asesores en vivo en el tablero
    renderBoardAdvisorsStrip(board.advisors || []);

    // Aplicar búsqueda y filtro por día/mes/año a las tablas del tablero
    const filteredWaiting = filterBoardTickets(board.waitingTickets || []);
    const filteredUnanswered = filterBoardTickets(board.unansweredTickets || []);

    document.getElementById('waitingCountBadge').textContent = `${filteredWaiting.length} de ${
      (board.waitingTickets || []).length
    } tickets`;
    document.getElementById('unansweredCountBadge').textContent = `${
      filteredUnanswered.length
    } de ${(board.unansweredTickets || []).length} tickets`;

    renderTicketsTable('tbodyWaiting', filteredWaiting, board.advisors || []);
    renderTicketsTable('tbodyUnanswered', filteredUnanswered, board.advisors || []);
    renderAdvisorsView(board.advisors || []);
    updateFloatingMultiBar(board.advisors || []);
  }

  function renderTicketsTable(tbodyId, tickets, advisors) {
    const tbody = document.getElementById(tbodyId);
    tbody.replaceChildren();

    if (tickets.length === 0) {
      tbody.appendChild(
        el('tr', {}, [
          el('td', {
            colSpan: 8,
            className: 'empty-state',
            textContent: 'No hay tickets en esta lista en este momento.'
          })
        ])
      );
      return;
    }

    const availableAdvisors = advisors.filter(
      (a) => a.disponible && a.currentLoad < a.tope_maximo
    );

    for (const t of tickets) {
      const chk = el('input', {
        type: 'checkbox',
        checked: state.selectedTickets.has(t.id),
        'aria-label': `Seleccionar ticket de ${t.contact?.name || ''}`
      });
      chk.addEventListener('change', () => {
        if (chk.checked) state.selectedTickets.add(t.id);
        else state.selectedTickets.delete(t.id);
        updateFloatingMultiBar(advisors);
      });

      const clientCell = el('td', {}, [
        el('div', { className: 'contact-name', textContent: t.contact?.name || 'Sin nombre' }),
        el('div', { className: 'contact-number', textContent: t.contact?.number || '' })
      ]);

      const channelCell = el('td', {}, [
        el('span', { className: 'badge badge-channel', textContent: t.channel || 'whatsapp' })
      ]);

      const deptBadge = t.hasNoDepartment
        ? el('span', { className: 'badge badge-no-dept', textContent: '⚠ Sin departamento' })
        : el('span', { className: 'badge', textContent: t.departmentName || 'Departamento' });

      const advisorCell = t.userId
        ? el('td', {}, [
            createClickableUserName(
              `${t.advisorName}${t.advisorType ? ' (' + t.advisorType + ')' : ''}`,
              t.userId
            )
          ])
        : el('td', { textContent: 'Sin asesor' });

      // Vista previa del último mensaje renderizada estrictamente con textContent
      const msgCell = el('td', {}, [
        el('div', {
          className: 'msg-preview',
          title: t.lastMessagePreview || '',
          textContent: t.lastMessagePreview || '(Sin texto)'
        })
      ]);

      const semIcon =
        t.semaphore === 'rojo' ? '▲ Rojo' : t.semaphore === 'amarillo' ? '◆ Amarillo' : '● Verde';
      const semChip = el('span', {
        className: `chip-semaforo ${t.semaphore}`,
        textContent: `${semIcon} · ${t.elapsedMinutes} min`
      });
      const timeCell = el('td', {}, [semChip]);
      if (t.protected) {
        timeCell.appendChild(
          el('div', {
            className: 'contact-number',
            textContent: 'Protegido (actividad reciente)'
          })
        );
      }

      // Selector individual "Asignar a..."
      const assignSelect = el('select', {
        className: 'select select-sm',
        'aria-label': 'Asignar a asesor'
      });
      assignSelect.appendChild(el('option', { value: '', textContent: 'Asignar a…' }));
      for (const a of availableAdvisors) {
        assignSelect.appendChild(
          el('option', {
            value: String(a.id),
            textContent: `${a.nombre_visible} (${a.currentLoad}/${a.tope_maximo})`
          })
        );
      }
      assignSelect.addEventListener('change', async () => {
        const advId = assignSelect.value;
        if (!advId) return;
        assignSelect.disabled = true;
        try {
          await assignTicketsManual([t.id], { advisorId: Number(advId), force: true });
        } finally {
          assignSelect.value = '';
          assignSelect.disabled = false;
        }
      });

      const btnTakeMe = el('button', {
        type: 'button',
        className: 'btn btn-sm',
        textContent: 'Tomar yo',
        onClick: () => takeTicketsBySupervisor([t.id])
      });

      const actionsCell = el('td', {}, [
        el('div', { className: 'toolbar-group' }, [assignSelect, btnTakeMe])
      ]);

      const tr = el('tr', {}, [
        el('td', {}, [chk]),
        clientCell,
        channelCell,
        el('td', {}, [deptBadge]),
        advisorCell,
        msgCell,
        timeCell,
        actionsCell
      ]);
      tbody.appendChild(tr);
    }
  }

  function updateFloatingMultiBar(advisors = []) {
    const bar = document.getElementById('floatingMultiBar');
    const count = state.selectedTickets.size;
    bar.classList.toggle('hidden', count === 0);
    document.getElementById('multiSelectedCount').textContent = `${count} ticket${
      count === 1 ? '' : 's'
    } seleccionado${count === 1 ? '' : 's'}`;

    const sel = document.getElementById('multiAssignAdvisorSelect');
    const prevVal = sel.value;
    sel.replaceChildren();
    sel.appendChild(el('option', { value: '', textContent: 'Elegir asesor…' }));
    for (const a of advisors.filter((x) => x.disponible && x.currentLoad < x.tope_maximo)) {
      sel.appendChild(
        el('option', {
          value: String(a.id),
          textContent: `${a.nombre_visible} (${a.currentLoad}/${a.tope_maximo})`,
          selected: String(a.id) === prevVal
        })
      );
    }
  }

  // --- VISTA POR ASESOR ---
  function renderAdvisorsView(advisors = []) {
    const grid = document.getElementById('advisorsCardsGrid');
    grid.replaceChildren();

    if (advisors.length === 0) {
      grid.appendChild(
        el('div', {
          className: 'card empty-state',
          textContent: 'No hay asesores configurados.'
        })
      );
      return;
    }

    for (const a of advisors) {
      const pct = Math.min(100, Math.round(((a.currentLoad || 0) / (a.tope_maximo || 15)) * 100));
      const barFill = el('div', {
        className: 'load-bar-fill' + (pct >= 100 ? ' full' : ''),
        style: { width: `${pct}%` }
      });

      const chkDisp = el('input', {
        type: 'checkbox',
        checked: Boolean(a.disponible)
      });
      chkDisp.addEventListener('change', async () => {
        try {
          const res = await api(`/api/advisors/${a.id}`, {
            method: 'PATCH',
            body: { disponible: chkDisp.checked }
          });
          state.board = res.board;
          renderBoard();
          showToast(`Disponibilidad de ${a.nombre_visible} actualizada.`);
        } catch (err) {
          chkDisp.checked = !chkDisp.checked;
          showToast(err.message, 'error');
        }
      });

      const inpTope = el('input', {
        type: 'number',
        min: 1,
        max: 200,
        className: 'input input-sm',
        style: { width: '64px' },
        value: a.tope_maximo
      });
      inpTope.addEventListener('change', async () => {
        try {
          const res = await api(`/api/advisors/${a.id}`, {
            method: 'PATCH',
            body: { tope_maximo: Number(inpTope.value) || 15 }
          });
          state.board = res.board;
          renderBoard();
          showToast(`Tope máximo de ${a.nombre_visible} actualizado.`);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      const inpPeso = el('input', {
        type: 'number',
        min: 1,
        max: 20,
        className: 'input input-sm',
        style: { width: '60px' },
        value: a.nivel || a.peso || 1
      });
      inpPeso.addEventListener('change', async () => {
        try {
          const res = await api(`/api/advisors/${a.id}`, {
            method: 'PATCH',
            body: { nivel: Math.max(1, Number(inpPeso.value) || 1) }
          });
          state.board = res.board;
          renderBoard();
          showToast(`Nivel de ${a.nombre_visible} actualizado.`);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      const btnPhoto = el('button', {
        type: 'button',
        className: 'btn btn-sm',
        textContent: 'Cambiar foto',
        onClick: () => {
          openPhotoPickerForAdvisor(a.fotoPerfil || a.foto_url, async (dataUrl) => {
            try {
              const res = await api(`/api/advisors/${a.id}`, {
                method: 'PATCH',
                body: { foto_url: dataUrl }
              });
              state.board = res.board;
              renderBoard();
              showToast(`Foto de perfil de ${a.nombre_visible} actualizada.`);
            } catch (err) {
              showToast(err.message, 'error');
            }
          });
        }
      });

      const btnRelease = el('button', {
        type: 'button',
        className: 'btn btn-sm btn-danger',
        textContent: `Quitarle todo a ${a.nombre_visible}`,
        disabled: (a.currentLoad || 0) === 0,
        onClick: () => openReleasePreviewModal(a)
      });

      const card = el('div', { className: 'card advisor-card' }, [
        el('div', { className: 'advisor-header' }, [
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
            createAvatarNode(a.nombre_visible, a.fotoPerfil || a.foto_url, 'lg'),
            el('div', {}, [
              createClickableUserName(a.nombre_visible, a.whaticket_user_id),
              el('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } }, [
                el('span', { className: 'badge', textContent: a.tipo }),
                createOnlineBadge(a)
              ])
            ])
          ]),
          btnPhoto
        ]),
        el('div', {
          textContent: `Carga actual: ${a.currentLoad || 0} / ${a.tope_maximo} tickets · Asignados hoy: ${a.assignedToday || 0}`
        }),
        el('div', { className: 'load-bar-track' }, [barFill]),
        el('div', {
          className: 'contact-number',
          textContent: `Tickets sin responder: ${a.unansweredCount || 0}`
        }),
        el(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } },
          [
            el('label', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
              chkDisp,
              el('span', { textContent: a.disponible ? 'Disponible' : 'No disponible' })
            ]),
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
              el('span', { className: 'contact-number', textContent: 'Tope:' }),
              inpTope,
              el('span', { className: 'contact-number', textContent: 'Nivel:' }),
              inpPeso
            ])
          ]
        ),
        btnRelease
      ]);

      grid.appendChild(card);
    }
  }

  // --- OPERACIONES DE ASIGNACIÓN Y MODAL DE VISTA PREVIA ---
  async function assignTicketsManual(ticketIds, { advisorId, userId, force = false }) {
    try {
      const res = await api('/api/tickets/assign', {
        method: 'POST',
        body: { ticketIds, advisorId, userId, force }
      });
      state.board = res.board;
      ticketIds.forEach((id) => state.selectedTickets.delete(id));
      renderBoard();
      const okCount = (res.results || []).filter((r) => r.ok).length;
      showToast(
        `${okCount} ticket(s) reasignado(s)${res.dryRun ? ' (Simulación)' : ''}.`
      );
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function takeTicketsBySupervisor(ticketIds) {
    const supId = state.board?.supervisorUserId || state.config?.supervisorUserId;
    if (!supId) {
      showToast(
        'Configura primero quién es el usuario supervisor en Configuración > Paso 2.',
        'error'
      );
      return;
    }
    await assignTicketsManual(ticketIds, { userId: supId, force: true });
  }

  async function openDistributionPreviewModal({ ticketIds = null }) {
    const mode = document.getElementById('boardDistMode').value || 'least_load';
    const advisorType = document.getElementById('boardAdvisorType').value || null;
    try {
      const preview = await api('/api/distribute?preview=true', {
        method: 'POST',
        body: { mode, advisorType, ticketIds, preview: true }
      });
      showPreviewModal({
        title: 'Confirmar reparto equitativo',
        previewData: preview,
        onConfirm: async (force) => {
          const res = await api('/api/distribute', {
            method: 'POST',
            body: { mode, advisorType, ticketIds, force }
          });
          state.board = res.board;
          state.selectedTickets.clear();
          renderBoard();
          showToast(
            `Reparto completado: ${(res.results || []).filter((r) => r.ok).length} ticket(s) movido(s).`
          );
        }
      });
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function openReleasePreviewModal(advisor) {
    const mode = document.getElementById('boardDistMode').value || 'least_load';
    try {
      const preview = await api(`/api/advisors/${advisor.id}/release?preview=true`, {
        method: 'POST',
        body: { mode, preview: true }
      });
      showPreviewModal({
        title: `Quitarle todo a ${advisor.nombre_visible}`,
        previewData: preview,
        onConfirm: async (force) => {
          const res = await api(`/api/advisors/${advisor.id}/release`, {
            method: 'POST',
            body: { mode, force }
          });
          state.board = res.board;
          renderBoard();
          showToast(`Se redistribuyeron los tickets de ${advisor.nombre_visible}.`);
        }
      });
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function showPreviewModal({ title, previewData, onConfirm }) {
    document.getElementById('previewModalTitle').textContent = title;
    document.getElementById('previewModalSummary').textContent =
      previewData.summaryText || 'Sin movimientos.';

    const listBox = document.getElementById('previewModalList');
    listBox.replaceChildren();
    for (const item of previewData.assignments || []) {
      listBox.appendChild(
        el('div', {
          style: { padding: '4px 0', borderBottom: '1px solid var(--border)' },
          textContent: `• ${item.contactName} → ${item.toAdvisorName} (${item.toAdvisorType})`
        })
      );
    }
    if ((previewData.assignments || []).length === 0) {
      listBox.appendChild(
        el('div', {
          className: 'contact-number',
          textContent: 'Ningún ticket se moverá con los criterios actuales.'
        })
      );
    }

    const protNotice = document.getElementById('previewProtectedNotice');
    const forceWrap = document.getElementById('previewForceWrap');
    const chkForce = document.getElementById('chkForceProtected');
    chkForce.checked = false;

    const protectedCount = (previewData.skippedProtected || []).length;
    if (protectedCount > 0) {
      protNotice.textContent = `${protectedCount} ticket(s) omitido(s) por tener conversación activa reciente.`;
      protNotice.classList.remove('hidden');
      forceWrap.classList.remove('hidden');
    } else {
      protNotice.classList.add('hidden');
      forceWrap.classList.add('hidden');
    }

    state.pendingBulkAction = onConfirm;
    document.getElementById('previewModalBackdrop').classList.remove('hidden');
  }

  // --- HISTORIAL Y EXPORTACIÓN CSV ---
  async function loadHistoryLogs() {
    try {
      const params = new URLSearchParams();
      const df = document.getElementById('logDateFrom').value;
      const dt = document.getElementById('logDateTo').value;
      const adv = document.getElementById('logAdvisorFilter').value.trim();
      const resFilter = document.getElementById('logResultFilter').value;
      if (df) params.set('dateFrom', df);
      if (dt) params.set('dateTo', dt);
      if (adv) params.set('advisor', adv);
      if (resFilter) params.set('resultado', resFilter);

      const data = await api(`/api/log?${params.toString()}`);
      state.logs = data.logs || [];
      renderHistoryTable();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderHistoryTable() {
    const tbody = document.getElementById('tbodyLogs');
    tbody.replaceChildren();
    if (state.logs.length === 0) {
      tbody.appendChild(
        el('tr', {}, [
          el('td', {
            colSpan: 8,
            className: 'empty-state',
            textContent: 'Sin registros en el historial con los filtros actuales.'
          })
        ])
      );
      return;
    }

    for (const row of state.logs) {
      const detailCell = el('td');
      if (row.resultado === 'error') {
        detailCell.appendChild(
          el('div', { className: 'contact-number', textContent: row.mensaje_error || 'Error' })
        );
        detailCell.appendChild(
          el('button', {
            type: 'button',
            className: 'btn btn-sm',
            textContent: 'Reintentar',
            onClick: async () => {
              try {
                await api(`/api/log/${row.id}/retry`, { method: 'POST' });
                showToast('Reintento exitoso.');
                loadHistoryLogs();
              } catch (err) {
                showToast(err.message, 'error');
                loadHistoryLogs();
              }
            }
          })
        );
      } else {
        detailCell.textContent = row.resultado === 'simulacion' ? 'Modo DRY_RUN' : 'Completado';
      }

      tbody.appendChild(
        el('tr', {}, [
          el('td', { textContent: new Date(row.fecha_hora).toLocaleString('es-CO') }),
          el('td', { textContent: row.ticket_id }),
          el('td', { textContent: row.cliente_nombre || '-' }),
          el('td', { textContent: row.asesor_origen || '-' }),
          el('td', { textContent: row.asesor_destino || '-' }),
          el('td', { textContent: row.accion }),
          el('td', { textContent: row.resultado }),
          detailCell
        ])
      );
    }
  }

  function exportHistoryCsv() {
    const headers = [
      'id',
      'fecha_hora',
      'ticket_id',
      'cliente_nombre',
      'asesor_origen',
      'asesor_destino',
      'accion',
      'resultado',
      'mensaje_error'
    ];
    const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const rows = state.logs.map((r) => headers.map((h) => escapeCsv(r[h])).join(','));
    const csvContent = [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = el('a', {
      href: url,
      download: `historial-reparto-${new Date().toISOString().slice(0, 10)}.csv`
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // --- VISTA GENERAL (ASIGNADOS POR USUARIO, POR DÍA, MES Y AÑO) ---
  function populateUserFilterSelects() {
    const advisors = state.board?.allAdvisorsConfig || state.config?.advisors || [];
    const targets = [
      document.getElementById('ovUserSelect'),
      document.getElementById('repUserSelect')
    ];
    for (const sel of targets) {
      if (!sel) continue;
      const prev = sel.value;
      sel.replaceChildren();
      sel.appendChild(el('option', { value: '', textContent: 'Todos los usuarios' }));
      for (const a of advisors) {
        sel.appendChild(
          el('option', {
            value: String(a.whaticket_user_id),
            textContent: `${a.nombre_visible} (${a.tipo})`,
            selected: String(a.whaticket_user_id) === prev
          })
        );
      }
    }
  }

  async function loadOverview() {
    try {
      const gran = document.getElementById('ovGranularity').value || 'day';
      const val =
        gran === 'day'
          ? document.getElementById('ovDateInput').value
          : gran === 'month'
          ? document.getElementById('ovMonthInput').value
          : document.getElementById('ovYearInput').value;
      const userId = document.getElementById('ovUserSelect').value || '';
      const incSim = document.getElementById('ovIncludeSim').checked;

      const params = new URLSearchParams({
        granularity: gran,
        includeSimulated: String(incSim)
      });
      if (val) params.set('value', val);
      if (userId) params.set('userId', userId);

      const data = await api(`/api/overview?${params.toString()}`);
      state.overview = data;
      renderOverview();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderOverview() {
    const data = state.overview;
    if (!data) return;

    const banner = document.getElementById('overviewTotalsBanner');
    banner.replaceChildren();
    const periodLabel =
      data.granularity === 'day'
        ? `Día ${data.value}`
        : data.granularity === 'month'
        ? `Mes ${data.value}`
        : `Año ${data.value}`;

    banner.appendChild(
      el('div', {}, [
        el('strong', { textContent: `Periodo consultado: ${periodLabel}` }),
        el('div', {
          className: 'contact-number',
          textContent: `Total de tickets asignados en el periodo: ${data.grandTotal || 0}`
        })
      ])
    );

    const tbodyUsers = document.getElementById('tbodyOverviewUsers');
    tbodyUsers.replaceChildren();
    const users = data.users || [];

    if (users.length === 0) {
      tbodyUsers.appendChild(
        el('tr', {}, [
          el('td', {
            colSpan: 9,
            className: 'empty-state',
            textContent: 'Sin datos para este periodo.'
          })
        ])
      );
    } else {
      for (const u of users) {
        const userCell = el('td', {}, [
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
            createAvatarNode(u.nombre, u.fotoPerfil, 'sm'),
            createClickableUserName(u.nombre, u.userId)
          ])
        ]);

        const statusCell = el('td', {}, [
          createOnlineBadge({ online: u.online, disponible: true })
        ]);

        const areaCell = el('td', {
          textContent: `${u.tipo || 'General'} · Nivel ${u.peso || 1}`
        });

        tbodyUsers.appendChild(
          el('tr', {}, [
            userCell,
            statusCell,
            areaCell,
            el('td', {}, [el('strong', { textContent: String(u.total || 0) })]),
            el('td', { textContent: String(u.byOrigin?.manual || 0) }),
            el('td', { textContent: String(u.byOrigin?.reparto || 0) }),
            el('td', { textContent: String(u.byOrigin?.auto || 0) }),
            el('td', { textContent: String(u.byOrigin?.liberar || 0) }),
            el('td', { textContent: String(u.byOrigin?.whaticket || 0) })
          ])
        );
      }
    }

    // Tabla de historial diario por usuario ordenada por mes y día
    const tbodyDailyByMonth = document.getElementById('tbodyOverviewDailyByMonth');
    if (tbodyDailyByMonth) {
      tbodyDailyByMonth.replaceChildren();
      const dailyRows = data.dailyUserRows || [];
      if (dailyRows.length === 0) {
        tbodyDailyByMonth.appendChild(
          el('tr', {}, [
            el('td', {
              colSpan: 8,
              className: 'empty-state',
              textContent: 'No hay asignaciones registradas por día en este periodo.'
            })
          ])
        );
      } else {
        for (const r of dailyRows) {
          const repAuto = Number(r.byOrigin?.reparto || 0) + Number(r.byOrigin?.auto || 0);
          tbodyDailyByMonth.appendChild(
            el('tr', {}, [
              el('td', { textContent: r.monthKey }),
              el('td', { textContent: r.dayKey }),
              el('td', {}, [
                el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
                  createAvatarNode(r.nombre, r.fotoPerfil, 'sm'),
                  createClickableUserName(r.nombre, r.userId, r.dayKey)
                ])
              ]),
              el('td', { textContent: `${r.tipo || 'General'} · Nivel ${r.nivel || 1}` }),
              el('td', {}, [
                el('strong', {
                  style: { fontSize: '15px', color: 'var(--primary)' },
                  textContent: `${r.totalDia} ticket(s)`
                })
              ]),
              el('td', { textContent: String(r.byOrigin?.manual || 0) }),
              el('td', { textContent: String(repAuto) }),
              el('td', { textContent: String(r.byOrigin?.whaticket || 0) })
            ])
          );
        }
      }
    }

    // Matriz cronológica por fila de usuario (días del mes, horas del día o meses del año)
    const theadMatrix = document.getElementById('theadOverviewMatrix');
    const tbodyMatrix = document.getElementById('tbodyOverviewMatrix');
    theadMatrix.replaceChildren();
    tbodyMatrix.replaceChildren();

    const buckets = data.buckets || [];
    const formatBucket = (b) => {
      if (data.granularity === 'day') return `${b}h`;
      if (data.granularity === 'month') return b.slice(-2);
      const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
      const mIdx = Number(b.slice(-2)) - 1;
      return months[mIdx] || b;
    };

    const headRow = el('tr', {}, [
      el('th', { className: 'sticky-col', textContent: 'Usuario' }),
      ...buckets.map((b) => el('th', { textContent: formatBucket(b) })),
      el('th', { textContent: 'Total' })
    ]);
    theadMatrix.appendChild(headRow);

    for (const u of users) {
      tbodyMatrix.appendChild(
        el('tr', {}, [
          el('td', { className: 'sticky-col' }, [
            createClickableUserName(u.nombre, u.userId)
          ]),
          ...buckets.map((b) => {
            const cnt = Number(u.counts?.[b] || 0);
            const dateArg = data.granularity === 'month' ? b : null;
            return el(
              'td',
              {
                style: {
                  color: cnt > 0 ? 'var(--primary)' : 'var(--muted)',
                  fontWeight: cnt > 0 ? '700' : '400',
                  cursor: cnt > 0 && dateArg ? 'pointer' : 'default'
                },
                title: cnt > 0 && dateArg ? `Ver los ${cnt} ticket(s) de ${u.nombre} el ${b}` : '',
                onClick:
                  cnt > 0 && dateArg ? () => openUserTicketsModal(u.userId, dateArg) : undefined
              },
              [String(cnt)]
            );
          }),
          el('td', {}, [el('strong', { textContent: String(u.total || 0) })])
        ])
      );
    }

    if (users.length > 0) {
      tbodyMatrix.appendChild(
        el('tr', {}, [
          el('td', { className: 'sticky-col' }, [el('strong', { textContent: 'TOTAL PERIODO' })]),
          ...buckets.map((b) =>
            el('td', {}, [el('strong', { textContent: String(data.totals?.[b] || 0) })])
          ),
          el('td', {}, [el('strong', { textContent: String(data.grandTotal || 0) })])
        ])
      );
    }
  }

  // --- INFORMES MENSUALES POR USUARIO ---
  async function loadMonthlyReport() {
    try {
      const month = document.getElementById('repMonthInput').value || '';
      const userId = document.getElementById('repUserSelect').value || '';
      const incSim = document.getElementById('repIncludeSim').checked;

      const params = new URLSearchParams({
        includeSimulated: String(incSim)
      });
      if (month) params.set('month', month);
      if (userId) params.set('userId', userId);

      const data = await api(`/api/reports/monthly?${params.toString()}`);
      state.monthlyReport = data;
      renderMonthlyReport();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderMonthlyReport() {
    const rep = state.monthlyReport;
    if (!rep) return;

    const headerCard = document.getElementById('reportHeaderCard');
    headerCard.replaceChildren();
    const selectedUserObj =
      rep.userId && (rep.users || []).find((u) => String(u.userId) === String(rep.userId));
    const targetName = selectedUserObj ? selectedUserObj.nombre : 'Todos los usuarios';

    headerCard.appendChild(
      el('div', { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' } }, [
        el('div', {}, [
          el('h3', {
            style: { margin: '0 0 4px 0', fontSize: '16px' },
            textContent: `Informe mensual de asignaciones — Mes ${rep.month}`
          }),
          el('div', {
            className: 'contact-number',
            textContent: `Usuario seleccionado: ${targetName}`
          })
        ]),
        el('div', {}, [
          el('div', { className: 'kpi-label', textContent: 'Total asignados en el mes' }),
          el('div', {
            style: { fontSize: '24px', fontWeight: '700', color: 'var(--primary)' },
            textContent: `${rep.grandTotal || 0} ticket(s)`
          })
        ])
      ])
    );

    const tbodySum = document.getElementById('tbodyReportSummary');
    tbodySum.replaceChildren();
    for (const u of rep.users || []) {
      tbodySum.appendChild(
        el('tr', {}, [
          el('td', {}, [
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
              createAvatarNode(u.nombre, u.fotoPerfil, 'sm'),
              createClickableUserName(u.nombre, u.userId)
            ])
          ]),
          el('td', { textContent: u.tipo || '-' }),
          el('td', { textContent: String(u.peso || 1) }),
          el('td', {}, [el('strong', { textContent: String(u.total || 0) })]),
          el('td', { textContent: String(u.byOrigin?.manual || 0) }),
          el('td', { textContent: String(u.byOrigin?.reparto || 0) }),
          el('td', { textContent: String(u.byOrigin?.auto || 0) }),
          el('td', { textContent: String(u.byOrigin?.whaticket || 0) })
        ])
      );
    }

    const tbodyDaily = document.getElementById('tbodyReportDaily');
    tbodyDaily.replaceChildren();
    const buckets = rep.buckets || [];
    for (const dayKey of buckets) {
      const cnt = Number(rep.totals?.[dayKey] || 0);
      tbodyDaily.appendChild(
        el('tr', {}, [
          el('td', { textContent: dayKey }),
          el('td', {}, [
            cnt > 0
              ? el('strong', { textContent: `${cnt} ticket(s)` })
              : el('span', { className: 'contact-number', textContent: '0' })
          ])
        ])
      );
    }

    const tbodyItems = document.getElementById('tbodyReportItems');
    tbodyItems.replaceChildren();
    const items = rep.items || [];
    if (items.length === 0) {
      tbodyItems.appendChild(
        el('tr', {}, [
          el('td', {
            colSpan: 6,
            className: 'empty-state',
            textContent: 'No hay tickets registrados en este mes para el filtro seleccionado.'
          })
        ])
      );
    } else {
      for (const it of items) {
        tbodyItems.appendChild(
          el('tr', {}, [
            el('td', { textContent: new Date(it.fechaHora).toLocaleString('es-CO') }),
            el('td', { textContent: it.advisorName }),
            el('td', { textContent: it.clienteNombre }),
            el('td', { textContent: it.clienteNumero || '-' }),
            el('td', { textContent: it.ticketId }),
            el('td', {
              textContent: it.origenLabel + (it.simulado ? ' (Simulación)' : '')
            })
          ])
        );
      }
    }
  }

  function exportMonthlyReportCsv() {
    const rep = state.monthlyReport;
    if (!rep) {
      showToast('Genera primero el informe mensual.', 'error');
      return;
    }
    const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const summaryHeaders = [
      'mes',
      'usuario',
      'area',
      'peso',
      'total_mes',
      'manual',
      'reparto',
      'automatico',
      'whaticket'
    ];
    const summaryRows = (rep.users || []).map((u) =>
      [
        rep.month,
        u.nombre,
        u.tipo || '',
        u.peso || 1,
        u.total || 0,
        u.byOrigin?.manual || 0,
        u.byOrigin?.reparto || 0,
        u.byOrigin?.auto || 0,
        u.byOrigin?.whaticket || 0
      ]
        .map(escapeCsv)
        .join(',')
    );

    const detailHeaders = [
      'fecha_hora',
      'dia',
      'usuario',
      'cliente_nombre',
      'cliente_telefono',
      'ticket_id',
      'origen',
      'simulado'
    ];
    const detailRows = (rep.items || []).map((it) =>
      [
        it.fechaHora,
        it.fechaDia,
        it.advisorName,
        it.clienteNombre,
        it.clienteNumero,
        it.ticketId,
        it.origenLabel,
        it.simulado ? 'SI' : 'NO'
      ]
        .map(escapeCsv)
        .join(',')
    );

    const csvContent = [
      '--- RESUMEN MENSUAL POR USUARIO ---',
      summaryHeaders.join(','),
      ...summaryRows,
      '',
      '--- DETALLE DE TICKETS ASIGNADOS EN EL MES ---',
      detailHeaders.join(','),
      ...detailRows
    ].join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = el('a', {
      href: url,
      download: `informe-mensual-${rep.month}${rep.userId ? '-usuario' : ''}.csv`
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function renderSettingsOverview() {
    const box = document.getElementById('settingsQuickSummary');
    box.replaceChildren();
    const cfg = state.config || {};
    const items = [
      `URL Base API: ${cfg.apiBaseUrl}`,
      `Token guardado: ${cfg.token?.configurado ? cfg.token.ultimos4 : 'No configurado'}`,
      `PIN de acceso: ${cfg.hasPin ? 'Configurado y activo' : 'Pendiente'}`,
      `Modo Simulación (DRY_RUN): ${cfg.dryRun ? 'Activado' : 'Desactivado (Producción)'}`,
      `Modo de reparto por defecto: ${cfg.defaultMode} | Reparto automático: ${
        cfg.autoAssign?.enabled ? 'Activado' : 'Desactivado'
      }`,
      `Umbrales semáforo: Verde < ${cfg.thresholds?.greenMaxMin} min, Amarillo <= ${cfg.thresholds?.yellowMaxMin} min`,
      `Minutos para Sin responder: ${cfg.unansweredMin} min | Minutos de protección: ${cfg.protectionMin} min`,
      `Intervalo de polling: ${cfg.pollingSec} s`
    ];
    for (const line of items) {
      box.appendChild(el('div', { style: { padding: '4px 0' }, textContent: line }));
    }
  }

  // --- CONEXIÓN SSE (CON RESPALDO POR POLLING EN NETLIFY SERVERLESS) ---
  let boardPollTimer = null;

  function startFallbackPolling() {
    if (boardPollTimer) return;
    const intervalSec = Math.max(10, Number(state.config?.pollingSec || 20));
    boardPollTimer = setInterval(async () => {
      if (document.hidden || !state.configured) return;
      try {
        state.board = await api('/api/board');
        renderBoard();
      } catch {}
    }, intervalSec * 1000);
  }

  function connectSse() {
    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }
    try {
      const es = new EventSource('/api/stream');
      es.addEventListener('board', (ev) => {
        try {
          state.board = JSON.parse(ev.data);
          renderBoard();
        } catch {}
      });
      es.addEventListener('error', () => {
        // En Netlify Functions (/api/stream no es SSE persistente), pasar a polling automático
        es.close();
        if (state.sse === es) state.sse = null;
        startFallbackPolling();
      });
      state.sse = es;
    } catch {
      startFallbackPolling();
    }
  }

  async function initApp() {
    try {
      const status = await api('/api/setup/status');
      state.configured = Boolean(status.configured);
      if (status.authenticated === false) {
        document.getElementById('pinModalBackdrop').classList.remove('hidden');
        return;
      }

      state.config = await api('/api/config');
      populateUserFilterSelects();
      if (!state.configured) {
        switchView('wizard');
      } else {
        state.board = await api('/api/board');
        renderBoard();
        switchView('board');
        connectSse();
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // --- EVENT LISTENERS ---
  document.addEventListener('DOMContentLoaded', () => {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const yearStr = String(now.getFullYear());

    // Inicializar valores de fecha por defecto en filtros, vista general e informes
    state.boardFilters.day = todayStr;
    state.boardFilters.month = monthStr;
    state.boardFilters.year = yearStr;
    document.getElementById('boardPeriodDate').value = todayStr;
    document.getElementById('boardPeriodMonth').value = monthStr;
    document.getElementById('boardPeriodYear').value = yearStr;
    document.getElementById('ovDateInput').value = todayStr;
    document.getElementById('ovMonthInput').value = monthStr;
    document.getElementById('ovYearInput').value = yearStr;
    document.getElementById('repMonthInput').value = monthStr;

    document.getElementById('btnThemeToggle').addEventListener('click', toggleTheme);

    document.getElementById('btnLockPin').addEventListener('click', async () => {
      try {
        await api('/api/auth/logout', { method: 'POST' });
        document.getElementById('pinModalBackdrop').classList.remove('hidden');
        document.getElementById('pinLoginInput').focus();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    document.getElementById('btnOpenWizardFromEmpty').addEventListener('click', () => {
      switchView('wizard');
    });

    document.getElementById('btnDisableDryRunQuick').addEventListener('click', () => {
      switchView('wizard');
      renderWizardStep(3);
    });

    document.getElementById('btnFixTokenBanner').addEventListener('click', () => {
      switchView('wizard');
      renderWizardStep(1);
    });

    document.getElementById('btnRefreshNow').addEventListener('click', async () => {
      try {
        state.board = await api('/api/board?refresh=true');
        renderBoard();
        showToast('Tablero actualizado.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Barra de búsqueda y filtro por día/mes/año en el Tablero
    const searchInput = document.getElementById('boardSearchInput');
    const periodModeSel = document.getElementById('boardPeriodMode');
    const periodDateInp = document.getElementById('boardPeriodDate');
    const periodMonthInp = document.getElementById('boardPeriodMonth');
    const periodYearInp = document.getElementById('boardPeriodYear');

    const syncBoardPeriodInputs = () => {
      const m = periodModeSel.value;
      state.boardFilters.periodMode = m;
      periodDateInp.classList.toggle('hidden', m !== 'day');
      periodMonthInp.classList.toggle('hidden', m !== 'month');
      periodYearInp.classList.toggle('hidden', m !== 'year');
      renderBoard();
    };

    searchInput.addEventListener('input', () => {
      state.boardFilters.search = searchInput.value;
      renderBoard();
    });
    periodModeSel.addEventListener('change', syncBoardPeriodInputs);
    periodDateInp.addEventListener('change', () => {
      state.boardFilters.day = periodDateInp.value;
      renderBoard();
    });
    periodMonthInp.addEventListener('change', () => {
      state.boardFilters.month = periodMonthInp.value;
      renderBoard();
    });
    periodYearInp.addEventListener('input', () => {
      state.boardFilters.year = periodYearInp.value;
      renderBoard();
    });
    document.getElementById('btnClearBoardFilters').addEventListener('click', () => {
      searchInput.value = '';
      periodModeSel.value = 'all';
      state.boardFilters.search = '';
      state.boardFilters.periodMode = 'all';
      syncBoardPeriodInputs();
    });

    async function saveBoardAutoRules({ mode, enabled }) {
      const cfg = state.config || (await api('/api/config'));
      state.config = await api('/api/setup/rules', {
        method: 'PUT',
        body: {
          greenMaxMin: cfg.thresholds?.greenMaxMin ?? 5,
          yellowMaxMin: cfg.thresholds?.yellowMaxMin ?? 15,
          unansweredMin: cfg.unansweredMin ?? 5,
          protectionMin: cfg.protectionMin ?? 3,
          pollingSec: cfg.pollingSec ?? 20,
          defaultMode: mode || cfg.defaultMode || 'weighted',
          dryRun: cfg.dryRun,
          autoAssignEnabled:
            enabled !== undefined ? enabled : Boolean(cfg.autoAssign?.enabled),
          autoAssignMinWait: cfg.autoAssign?.minWaitMin ?? 0,
          autoAssignType: cfg.autoAssign?.advisorType || 'all',
          autoOnlyOnline: cfg.autoAssign?.onlyOnline !== false
        }
      });
      state.board = await api('/api/board');
      renderBoard();
    }

    document.getElementById('boardDistMode').addEventListener('change', async (ev) => {
      const newMode = ev.target.value;
      ev.target.dataset.userChanged = '1';
      try {
        await saveBoardAutoRules({ mode: newMode });
        const labels = {
          weighted: 'Turnos por Nivel (uno a la vez)',
          least_load: 'Menor carga',
          round_robin: 'Turnos simples (Round-Robin)'
        };
        showToast(`Modo de reparto guardado: ${labels[newMode] || newMode}.`);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Activar/desactivar reparto automático directamente desde el tablero
    document.getElementById('chkBoardAutoAssign').addEventListener('change', async (ev) => {
      const enabled = ev.target.checked;
      try {
        const mode = document.getElementById('boardDistMode').value;
        await saveBoardAutoRules({ mode, enabled });
        showToast(
          enabled
            ? 'Asignación automática por reglas activada.'
            : 'Asignación automática desactivada.'
        );
      } catch (err) {
        ev.target.checked = !enabled;
        showToast(err.message, 'error');
      }
    });

    // Controles de Vista General (día, mes, año)
    const ovGranSel = document.getElementById('ovGranularity');
    ovGranSel.addEventListener('change', () => {
      const g = ovGranSel.value;
      document.getElementById('ovDateInput').classList.toggle('hidden', g !== 'day');
      document.getElementById('ovMonthInput').classList.toggle('hidden', g !== 'month');
      document.getElementById('ovYearInput').classList.toggle('hidden', g !== 'year');
      loadOverview();
    });
    document.getElementById('btnRefreshOverview').addEventListener('click', loadOverview);

    // Controles de Informes Mensuales por Usuario
    document.getElementById('btnGenerateReport').addEventListener('click', loadMonthlyReport);
    document.getElementById('btnExportReportCsv').addEventListener('click', exportMonthlyReportCsv);
    document.getElementById('btnPrintReport').addEventListener('click', () => window.print());

    // Modal de tickets de un usuario (al darle clic a su nombre)
    document.getElementById('btnCloseUserTicketsModal').addEventListener('click', () => {
      document.getElementById('userTicketsModalBackdrop').classList.add('hidden');
    });
    document.getElementById('userModalDateInput').addEventListener('change', (ev) => {
      if (currentModalUserId) {
        openUserTicketsModal(currentModalUserId, ev.target.value);
      }
    });

    // Paso 1 Wizard: Mostrar/Ocultar token solo mientras se escribe
    const wizTokenInput = document.getElementById('wizToken');
    const btnToggleToken = document.getElementById('btnToggleWizToken');
    btnToggleToken.addEventListener('click', () => {
      const isPwd = wizTokenInput.type === 'password';
      wizTokenInput.type = isPwd ? 'text' : 'password';
      btnToggleToken.textContent = isPwd ? 'Ocultar' : 'Mostrar';
    });

    document.getElementById('btnTestConnectionWiz').addEventListener('click', async () => {
      const baseUrl = document.getElementById('wizBaseUrl').value.trim();
      const token = wizTokenInput.value.trim();
      const resultBox = document.getElementById('wizConnResult');
      resultBox.className = 'status-box';
      resultBox.textContent = 'Probando conexión con Whaticket...';
      resultBox.classList.remove('hidden');

      try {
        const res = await api('/api/setup/test-connection', {
          method: 'POST',
          body: { baseUrl, token: token || undefined }
        });
        state.connectionTestPassed = true;
        document.getElementById('btnWizNext1').disabled = false;
        resultBox.className = 'status-box ok';
        const warnSuffix = res.warning ? ` (Aviso: ${res.warning})` : '';
        resultBox.textContent = `Conexión exitosa (${res.companyName}). Se encontraron ${res.usersCount} usuario(s) y ${res.departmentsCount} departamento(s).${warnSuffix}`;
      } catch (err) {
        state.connectionTestPassed = false;
        resultBox.className = 'status-box error';
        resultBox.textContent = err.message;
      }
    });

    document.getElementById('btnWizNext1').addEventListener('click', async () => {
      const baseUrl = document.getElementById('wizBaseUrl').value.trim();
      const token = wizTokenInput.value.trim();
      try {
        state.config = await api('/api/setup/connection', {
          method: 'PUT',
          body: { baseUrl, token: token || undefined }
        });
        wizTokenInput.value = '';
        wizTokenInput.type = 'password';
        const imp = await api('/api/setup/import', { method: 'POST' });
        state.config.advisors = imp.advisors;
        state.config.departments = imp.departments;
        renderWizardStep(2);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('btnReimportWiz').addEventListener('click', async () => {
      try {
        const imp = await api('/api/setup/import', { method: 'POST' });
        state.config.advisors = imp.advisors;
        state.config.departments = imp.departments;
        renderWizardAdvisorsTable();
        showToast(
          `Importados ${imp.usersCount} usuario(s) y ${imp.departmentsCount} departamento(s) sin pisar cambios.`
        );
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('btnAddManualUser').addEventListener('click', () => {
      const uid = document.getElementById('manualUserId').value.trim();
      const uname = document.getElementById('manualUserName').value.trim();
      if (!uid || !uname) {
        showToast('Ingresa el UUID y el nombre visible del usuario.', 'error');
        return;
      }
      state.config.advisors = state.config.advisors || [];
      if (!state.config.advisors.some((a) => String(a.whaticket_user_id) === uid)) {
        state.config.advisors.push({
          whaticket_user_id: uid,
          nombre_visible: uname,
          incluido: true,
          tipo: 'Digital',
          disponible: true,
          tope_maximo: 15,
          peso: 1,
          foto_url: null
        });
      }
      document.getElementById('manualUserId').value = '';
      document.getElementById('manualUserName').value = '';
      renderWizardAdvisorsTable();
    });

    document.getElementById('btnWizPrev2').addEventListener('click', () => renderWizardStep(1));
    document.getElementById('btnWizNext2').addEventListener('click', async () => {
      try {
        const supId = document.getElementById('wizSupervisorSelect').value;
        state.config = await api('/api/setup/advisors', {
          method: 'PUT',
          body: {
            advisors: state.config.advisors || [],
            supervisorUserId: supId || null
          }
        });
        renderWizardStep(3);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('btnWizPrev3').addEventListener('click', () => renderWizardStep(2));
    document.getElementById('btnWizNext3').addEventListener('click', async () => {
      try {
        state.config = await api('/api/setup/rules', {
          method: 'PUT',
          body: {
            greenMaxMin: Number(document.getElementById('wizGreenMin').value),
            yellowMaxMin: Number(document.getElementById('wizYellowMin').value),
            unansweredMin: Number(document.getElementById('wizUnansweredMin').value),
            protectionMin: Number(document.getElementById('wizProtectionMin').value),
            pollingSec: Number(document.getElementById('wizPollingSec').value),
            defaultMode: document.getElementById('wizDefaultMode').value,
            dryRun: document.getElementById('wizDryRun').checked,
            autoAssignEnabled: document.getElementById('wizAutoAssignEnabled').checked,
            autoAssignMinWait: Number(document.getElementById('wizAutoMinWait').value) || 0,
            autoAssignType: document.getElementById('wizAutoType').value || 'all',
            autoOnlyOnline: document.getElementById('wizAutoOnlyOnline').checked
          }
        });
        renderWizardStep(4);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('btnWizPrev4').addEventListener('click', () => renderWizardStep(3));
    document.getElementById('btnWizFinish').addEventListener('click', async () => {
      try {
        const pin = document.getElementById('wizPin').value.trim();
        state.config = await api('/api/setup/access', {
          method: 'PUT',
          body: { pin: pin || undefined, markConfigured: true }
        });
        state.configured = true;
        populateUserFilterSelects();
        state.board = await api('/api/board?refresh=true');
        renderBoard();
        switchView('board');
        connectSse();
        showToast('Configuración guardada y aplicada en caliente.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Selección múltiple y reparto
    document.getElementById('chkAllWaiting').addEventListener('change', (ev) => {
      const checked = ev.target.checked;
      for (const t of filterBoardTickets(state.board?.waitingTickets || [])) {
        if (checked) state.selectedTickets.add(t.id);
        else state.selectedTickets.delete(t.id);
      }
      renderBoard();
    });

    document.getElementById('chkAllUnanswered').addEventListener('change', (ev) => {
      const checked = ev.target.checked;
      for (const t of filterBoardTickets(state.board?.unansweredTickets || [])) {
        if (checked) state.selectedTickets.add(t.id);
        else state.selectedTickets.delete(t.id);
      }
      renderBoard();
    });

    document.getElementById('btnDistributeWaiting').addEventListener('click', () => {
      openDistributionPreviewModal({ ticketIds: null });
    });

    document.getElementById('btnMultiDistribute').addEventListener('click', () => {
      openDistributionPreviewModal({ ticketIds: Array.from(state.selectedTickets) });
    });

    document.getElementById('btnMultiAssignManual').addEventListener('click', () => {
      const advId = document.getElementById('multiAssignAdvisorSelect').value;
      if (!advId) {
        showToast('Selecciona un asesor en la barra inferior.', 'error');
        return;
      }
      assignTicketsManual(Array.from(state.selectedTickets), {
        advisorId: Number(advId),
        force: false
      });
    });

    document.getElementById('btnMultiTakeMe').addEventListener('click', () => {
      takeTicketsBySupervisor(Array.from(state.selectedTickets));
    });

    document.getElementById('btnMultiClear').addEventListener('click', () => {
      state.selectedTickets.clear();
      renderBoard();
    });

    // Modal de vista previa
    document.getElementById('btnCancelPreviewModal').addEventListener('click', () => {
      document.getElementById('previewModalBackdrop').classList.add('hidden');
      state.pendingBulkAction = null;
    });

    document.getElementById('btnConfirmPreviewModal').addEventListener('click', async () => {
      const fn = state.pendingBulkAction;
      const force = document.getElementById('chkForceProtected').checked;
      document.getElementById('previewModalBackdrop').classList.add('hidden');
      state.pendingBulkAction = null;
      if (fn) {
        try {
          await fn(force);
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    });

    // Historial y Configuración
    document.getElementById('btnFilterLogs').addEventListener('click', loadHistoryLogs);
    document.getElementById('btnExportCsv').addEventListener('click', exportHistoryCsv);
    document.getElementById('btnLaunchWizardAgain').addEventListener('click', () => {
      switchView('wizard');
      renderWizardStep(1);
    });

    document.getElementById('btnDeleteSavedToken').addEventListener('click', async () => {
      if (!window.confirm('¿Estás seguro de borrar el token de API guardado?')) return;
      try {
        state.config = await api('/api/setup/token', { method: 'DELETE' });
        renderSettingsOverview();
        showToast('Token eliminado correctamente.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Modal de exportación de contactos de Whaticket
    const exportBackdrop = document.getElementById('exportContactsModalBackdrop');
    const exportLoadingBox = document.getElementById('exportContactsLoading');
    const exportResultBox = document.getElementById('exportContactsResult');
    const btnOpenExportModal = document.getElementById('btnOpenExportContactsModal');
    const btnCloseExportModal = document.getElementById('btnCloseExportContactsModal');
    const btnRunExport = document.getElementById('btnRunExportContacts');
    const selExportMinMsgs = document.getElementById('exportContactsMinMessages');
    const selExportStatuses = document.getElementById('exportContactsStatuses');
    let exportInProgress = false;

    const setExportBusy = (busy) => {
      exportInProgress = busy;
      exportLoadingBox.classList.toggle('hidden', !busy);
      btnRunExport.disabled = busy;
      btnCloseExportModal.disabled = busy;
      selExportMinMsgs.disabled = busy;
      selExportStatuses.disabled = busy;
      document.querySelectorAll('input[name="exportContactsFormat"]').forEach((inp) => {
        inp.disabled = busy;
      });
      btnRunExport.textContent = busy ? 'Procesando...' : 'Consultar y descargar';
    };

    const closeExportModal = () => {
      if (exportInProgress) return;
      exportBackdrop.classList.add('hidden');
    };

    const buildDiscardBreakdownText = (summary) => {
      const r = summary?.reasons || {};
      const parts = [];
      if (r.insufficientMessages) parts.push(`${r.insufficientMessages} con pocos mensajes del cliente`);
      if (r.duplicate) parts.push(`${r.duplicate} duplicado(s)`);
      if (r.invalidNumber) parts.push(`${r.invalidNumber} número inválido`);
      if (r.group) parts.push(`${r.group} grupo(s)`);
      if (r.nonWhatsapp) parts.push(`${r.nonWhatsapp} otro canal`);
      if (r.fetchError) parts.push(`${r.fetchError} error al leer mensajes`);
      return parts.join(', ');
    };

    const runWhaticketContactsExport = async () => {
      if (exportInProgress) return;
      const formatInput = document.querySelector('input[name="exportContactsFormat"]:checked');
      const format = formatInput ? formatInput.value : 'xlsx';
      const minClientMessages = Number(selExportMinMsgs.value || 2);
      const statuses = String(selExportStatuses.value || 'open,pending,closed')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      exportResultBox.className = 'status-box hidden';
      exportResultBox.replaceChildren();
      setExportBusy(true);

      try {
        const res = await fetch('/api/contacts/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format, minClientMessages, statuses })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          if (res.status === 401 && errData.pinRequired) {
            exportBackdrop.classList.add('hidden');
            document.getElementById('pinModalBackdrop').classList.remove('hidden');
            showToast(errData.error || 'PIN requerido', 'error');
            return;
          }
          throw new Error(errData.error || `Error HTTP ${res.status}`);
        }

        const rawSummary = res.headers.get('X-Export-Summary');
        let summary = null;
        if (rawSummary) {
          try {
            summary = JSON.parse(decodeURIComponent(rawSummary));
          } catch {}
        }
        const exported = Number(
          summary?.exported ?? res.headers.get('X-Export-Exported-Count') ?? 0
        );
        const discarded = Number(
          summary?.discarded ?? res.headers.get('X-Export-Discarded-Count') ?? 0
        );
        const totalTickets = Number(
          summary?.totalTickets ?? res.headers.get('X-Export-Total-Tickets') ?? exported + discarded
        );

        let filename = res.headers.get('X-Export-Filename');
        if (!filename) {
          const disp = res.headers.get('Content-Disposition') || '';
          const match = disp.match(/filename="?([^";]+)"?/i);
          filename = match ? match[1] : `contactos-whaticket.${format}`;
        }

        const blob = await res.blob();
        const detailText = buildDiscardBreakdownText(summary);

        if (exported > 0) {
          const url = URL.createObjectURL(blob);
          const link = el('a', { href: url, download: filename });
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);

          exportResultBox.className = 'status-box ok';
          exportResultBox.replaceChildren(
            el('div', {
              textContent: `Archivo descargado: ${filename} (${exported} contacto(s) exportado(s), ${discarded} descartado(s) de ${totalTickets} ticket(s)).`
            })
          );
          if (detailText) {
            exportResultBox.appendChild(
              el('div', { className: 'form-hint', textContent: `Descartes: ${detailText}.` })
            );
          }
          showToast(
            `Exportados ${exported} contacto(s) · Descartados: ${discarded}${
              detailText ? ` (${detailText})` : ''
            }.`,
            'ok',
            6000
          );
        } else {
          exportResultBox.className = 'status-box';
          exportResultBox.replaceChildren(
            el('div', {
              textContent: `0 contactos exportados (${discarded} descartado(s) de ${totalTickets} ticket(s)). No se generó descarga vacía.`
            })
          );
          if (detailText) {
            exportResultBox.appendChild(
              el('div', { className: 'form-hint', textContent: `Motivos: ${detailText}.` })
            );
          }
          showToast(
            `0 contactos cumplieron los filtros (${discarded} descartado(s)).`,
            'error',
            6000
          );
        }
      } catch (err) {
        exportResultBox.className = 'status-box error';
        exportResultBox.replaceChildren(el('div', { textContent: err.message }));
        showToast(err.message, 'error', 5500);
      } finally {
        setExportBusy(false);
      }
    };

    if (btnOpenExportModal) {
      btnOpenExportModal.addEventListener('click', () => {
        exportResultBox.className = 'status-box hidden';
        exportResultBox.replaceChildren();
        exportLoadingBox.classList.add('hidden');
        exportBackdrop.classList.remove('hidden');
      });
    }
    if (btnCloseExportModal) {
      btnCloseExportModal.addEventListener('click', closeExportModal);
    }
    if (btnRunExport) {
      btnRunExport.addEventListener('click', runWhaticketContactsExport);
    }
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && exportBackdrop && !exportBackdrop.classList.contains('hidden')) {
        closeExportModal();
      }
    });

    // Login con PIN (soporta clic y tecla Enter)
    const submitPinLogin = async () => {
      const pin = document.getElementById('pinLoginInput').value;
      try {
        await api('/api/auth/login', { method: 'POST', body: { pin } });
        document.getElementById('pinModalBackdrop').classList.add('hidden');
        document.getElementById('pinLoginInput').value = '';
        initApp();
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
    document.getElementById('btnSubmitPinLogin').addEventListener('click', submitPinLogin);
    document.getElementById('pinLoginInput').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submitPinLogin();
    });

    initApp();
  });
})();
