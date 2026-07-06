function safe(sel, ctx) { try { return (ctx || document).querySelector(sel); } catch(e) { return null; } }
function safeAll(sel, ctx) { try { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); } catch(e) { return []; } }

(function() {
  var navToggle = safe('#navToggle');
  var navLinks = safe('.nav-links');
  if (navToggle && navLinks) {
    navToggle.addEventListener('click', function() {
      navLinks.classList.toggle('open');
      navToggle.classList.toggle('active');
    });
    safeAll('.nav-links a, .nav-links button').forEach(function(el) {
      el.addEventListener('click', function() {
        navLinks.classList.remove('open');
        navToggle.classList.remove('active');
      });
    });
  }
})();

var MAX_QTY = 10;

function getCart() {
  var items = [];
  var grandTotal = 0;
  var grandQty = 0;
  safeAll('.ticket-type').forEach(function(el) {
    var input = safe('.qty-input', el);
    if (!input) return;
    var qty = parseInt(input.value, 10) || 0;
    if (qty > 0) {
      var type = el.getAttribute('data-ticket-type');
      var price = parseInt(el.getAttribute('data-ticket-price')) || 0;
      items.push({ type: type, qty: qty, price: price });
      grandTotal += price * qty;
      grandQty += qty;
    }
  });
  var summary = items.map(function(item) {
    return item.type + ' x' + item.qty;
  }).join(', ');
  return { items: items, grandTotal: grandTotal, grandQty: grandQty, summary: summary };
}

function updateCheckout() {
  try {
    var cart = getCart();
    var link = safe('.btn-get-tickets');
    if (!link) return;

    safeAll('.ticket-type').forEach(function(el) {
      var input = safe('.qty-input', el);
      if (!input) return;
      var qty = parseInt(input.value, 10) || 0;
      var price = parseInt(el.getAttribute('data-ticket-price')) || 0;
      var totalEl = safe('.ticket-type-price', el);
      if (totalEl) {
        totalEl.setAttribute('data-total', price * qty);
        if (qty > 0) {
          totalEl.textContent = 'KES ' + (price * qty).toLocaleString() + ' (' + qty + ' x KES ' + price.toLocaleString() + ')';
        } else {
          totalEl.textContent = 'KES ' + price.toLocaleString();
        }
      }
    });

    if (cart.grandQty === 0) {
      link.textContent = 'Select Tickets';
      link.href = '#';
      link.classList.add('disabled');
      return;
    }
    link.textContent = 'Get Tickets - KES ' + cart.grandTotal.toLocaleString();
    link.classList.remove('disabled');
    link.href = '/payment?amount=' + cart.grandTotal +
      '&ticketType=' + encodeURIComponent(cart.summary) +
      '&qty=' + cart.grandQty;
  } catch(e) {
    console.error('[CART]', e);
  }
}

function clampQty(input) {
  if (!input) return;
  var min = parseInt(input.getAttribute('min'), 10) || 0;
  var max = parseInt(input.getAttribute('max'), 10) || MAX_QTY;
  if (input.value === '' || input.value === '-') return;
  var val = parseInt(input.value, 10);
  if (isNaN(val) || val < min) input.value = min;
  else if (val > max) input.value = max;
}

safeAll('.ticket-type').forEach(function(el) {
  el.addEventListener('click', function(e) {
    if (e.target.closest('.qty-btn') || e.target.closest('.qty-input') || e.target.closest('.qty-selector')) return;
    safeAll('.ticket-type').forEach(function(t) { t.classList.remove('selected'); });
    this.classList.add('selected');
  });
});

safeAll('.qty-btn').forEach(function(btn) {
  btn.addEventListener('click', function(e) {
    try {
      e.stopPropagation();
      var selector = this.closest('.qty-selector');
      if (!selector) return;
      var input = safe('.qty-input', selector);
      if (!input) return;
      var min = parseInt(input.getAttribute('min'), 10) || 0;
      var max = parseInt(input.getAttribute('max'), 10) || MAX_QTY;
      var val = parseInt(input.value, 10) || 0;
      if (this.textContent.trim() === '+') {
        if (val < max) input.value = val + 1;
      } else if (val > min) {
        input.value = val - 1;
      }
      updateCheckout();
    } catch(e) {
      console.error('[BTN]', e);
    }
  });
});

safeAll('.qty-input').forEach(function(input) {
  input.addEventListener('change', function() {
    clampQty(this);
    updateCheckout();
  });
  input.addEventListener('input', function() {
    updateCheckout();
  });
});

updateCheckout();

var watchCount = 1827;
setInterval(function() {
  watchCount += Math.floor(Math.random() * 3);
  var el = safe('.hero-stat-value');
  if (el) el.textContent = watchCount.toLocaleString();
}, 5000);

setTimeout(function() {
  var fill = safe('.progress-fill');
  if (fill) fill.style.width = '82%';
}, 1000);
