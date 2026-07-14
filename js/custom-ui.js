class CustomSelect {
  constructor(selectElement) {
    this.select = selectElement;
    this.select.style.display = 'none';
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'custom-select-wrapper';
    
    this.trigger = document.createElement('div');
    this.trigger.className = 'custom-select-trigger';
    
    this.optionsContainer = document.createElement('div');
    this.optionsContainer.className = 'custom-select-options';
    
    this.wrapper.appendChild(this.trigger);
    this.wrapper.appendChild(this.optionsContainer);
    this.select.parentNode.insertBefore(this.wrapper, this.select.nextSibling);
    
    this.buildOptions();
    this.updateTrigger();
    
    this.trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = this.wrapper.classList.contains('open');
      document.querySelectorAll('.custom-select-wrapper').forEach(w => w.classList.remove('open'));
      if (!isOpen) {
        this.wrapper.classList.add('open');
      }
    });
    
    document.addEventListener('click', (e) => {
      if (!this.wrapper.contains(e.target)) {
        this.wrapper.classList.remove('open');
      }
    });

    this.select.addEventListener('change', () => {
      this.updateTrigger();
      this.buildOptions(); 
    });
  }

  buildOptions() {
    this.options = Array.from(this.select.options);
    this.optionsContainer.innerHTML = '';
    this.options.forEach((option, index) => {
      const optEl = document.createElement('div');
      optEl.className = 'custom-option';
      if (this.select.selectedIndex === index) optEl.classList.add('selected');
      optEl.textContent = option.textContent;
      optEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select.selectedIndex = index;
        this.select.dispatchEvent(new Event('change'));
        this.wrapper.classList.remove('open');
      });
      this.optionsContainer.appendChild(optEl);
    });
  }

  updateTrigger() {
    const selectedOption = this.select.options[this.select.selectedIndex];
    this.trigger.innerHTML = `<span>${selectedOption ? selectedOption.textContent : ''}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`;
  }
}

class CustomDatePicker {
  constructor(inputElement) {
    this.input = inputElement;
    
    // Change input type to text to prevent native picker
    if(this.input.type === 'date') {
      this.input.type = 'text';
    }
    this.input.setAttribute('readonly', 'true');
    this.input.classList.add('custom-date-input');
    
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'custom-date-wrapper';
    
    this.input.parentNode.insertBefore(this.wrapper, this.input);
    this.wrapper.appendChild(this.input);
    
    this.popup = document.createElement('div');
    this.popup.className = 'custom-date-popup';
    this.wrapper.appendChild(this.popup);
    
    this.currentDate = new Date();
    this.selectedDate = null;
    
    this.initPopup();
    
    this.input.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = this.popup.classList.contains('open');
      document.querySelectorAll('.custom-date-popup').forEach(p => p.classList.remove('open'));
      if (!isOpen) {
        if(this.input.value) {
          // parse YYYY-MM-DD avoiding timezone offset issues
          const parts = this.input.value.split('-');
          if(parts.length === 3) {
            this.selectedDate = new Date(parts[0], parts[1]-1, parts[2]);
            this.currentDate = new Date(this.selectedDate);
          }
        } else {
          this.selectedDate = null;
          this.currentDate = new Date();
        }
        this.renderCalendar();
        this.popup.classList.add('open');
      }
    });
    
    document.addEventListener('click', (e) => {
      if (!this.wrapper.contains(e.target)) {
        this.popup.classList.remove('open');
      }
    });
    
    // Observe value changes to clear if cleared externally
    const observer = new MutationObserver(() => {
      if (!this.input.value) {
         this.selectedDate = null;
      }
    });
    observer.observe(this.input, { attributes: true, attributeFilter: ['value'] });
  }
  
  initPopup() {
    this.header = document.createElement('div');
    this.header.className = 'date-header';
    
    this.prevBtn = document.createElement('button');
    this.prevBtn.type = 'button';
    this.prevBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>';
    this.prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.changeMonth(-1); });
    
    this.nextBtn = document.createElement('button');
    this.nextBtn.type = 'button';
    this.nextBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>';
    this.nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.changeMonth(1); });
    
    this.monthDisplay = document.createElement('div');
    this.monthDisplay.className = 'date-month-display';
    
    this.header.appendChild(this.prevBtn);
    this.header.appendChild(this.monthDisplay);
    this.header.appendChild(this.nextBtn);
    
    this.daysGrid = document.createElement('div');
    this.daysGrid.className = 'date-days-grid';
    
    this.popup.appendChild(this.header);
    this.popup.appendChild(this.daysGrid);
    
    this.renderCalendar();
  }
  
  changeMonth(delta) {
    this.currentDate.setMonth(this.currentDate.getMonth() + delta);
    this.renderCalendar();
  }
  
  renderCalendar() {
    this.monthDisplay.textContent = this.currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });
    this.daysGrid.innerHTML = '';
    
    const daysOfWeek = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    daysOfWeek.forEach(d => {
      const el = document.createElement('div');
      el.className = 'date-day-name';
      el.textContent = d;
      this.daysGrid.appendChild(el);
    });
    
    const year = this.currentDate.getFullYear();
    const month = this.currentDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    
    for (let i = 0; i < firstDay; i++) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'date-day empty';
      this.daysGrid.appendChild(emptyEl);
    }
    
    for (let i = 1; i <= daysInMonth; i++) {
      const dayEl = document.createElement('div');
      dayEl.className = 'date-day';
      dayEl.textContent = i;
      
      if (this.selectedDate && 
          this.selectedDate.getDate() === i && 
          this.selectedDate.getMonth() === month && 
          this.selectedDate.getFullYear() === year) {
        dayEl.classList.add('selected');
      }
      
      if (today.getDate() === i && 
          today.getMonth() === month && 
          today.getFullYear() === year) {
        dayEl.classList.add('today');
      }
      
      dayEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const y = year;
        const m = String(month + 1).padStart(2, '0');
        const d = String(i).padStart(2, '0');
        this.input.value = `${y}-${m}-${d}`;
        this.selectedDate = new Date(year, month, i);
        this.input.dispatchEvent(new Event('change'));
        this.popup.classList.remove('open');
      });
      
      this.daysGrid.appendChild(dayEl);
    }
  }
}

// Initialize custom components
document.addEventListener('DOMContentLoaded', () => {
  const selects = ['statusFilterSelect', 'sortSelect', 'statusInput'];
  selects.forEach(id => {
    const el = document.getElementById(id);
    if(el) new CustomSelect(el);
  });
  
  const dueInput = document.getElementById('dueInput');
  if(dueInput) new CustomDatePicker(dueInput);
});
