(function(factory) {
  if (typeof define === 'function' && define.amd) {
    define(['knockout', 'knockout-css3-animation'], factory)
  } else if (typeof exports === 'object' && typeof module === 'object') {
    module.exports = factory(require('knockout'), require('knockout-css3-animation'))
  } else {
    window.Frypan = factory(ko)
  }
})(function(ko) {

  function Frypan(params) {
    var
      async = typeof ko.unwrap(params.data) === 'function',
      computeds = [],
      computed = function(func, throttle) {
        var c = throttle ? ko.computed(func).extend({ throttle: throttle }) : ko.computed(func)
        computeds.push(c)
        return c
      }

    this.dispose = function() {
      computeds.forEach(function(c) { c.dispose() })
    }

    var grid = this
    grid.searchTerm = params.searchTerm || ko.observable()
    grid.showFilters = params.showFilters || ko.observable()
    grid.sortColumn = params.sortColumn || ko.observable()
    grid.sortAscending = params.sortAscending || ko.observable(true)
    grid.offset = ko.observable(0)
    grid.visibleRowCount = ko.observable(500)
    grid.sortedItems = ko.observableArray([]) // sync data sources replaces this with a computed
    ;['loadingHtml', 'filterToggleTemplate', 'rowClick', 'rowClass', 'resizableColumns'].forEach(function(p) {
      if (p in params) grid[p] = params[p]
    })

    if (!Array.isArray(ko.unwrap(params.columns))) {
      var sampleItemKeys = computed(function() {
        var sampleItem = async ? grid.sortedItems()[0] : ko.unwrap(params.data)[0]
        // returning a joined string here as observables don't do deep equals
        return sampleItem ? Object.keys(sampleItem).join('🙈') : ''
      })
    }

    grid.columns = computed(function() {
      var cols = ko.unwrap(params.columns) || sampleItemKeys().split('🙈').map(function(k) { return { text: k, name: k } })
      return cols.map(function(col, idx) {
        if (col.filterTemplate) {
          if (typeof col.filter !== 'function' && !async) {
            throw new Error('A filter function is required when filtering synchronous sources')
          }
          if (!ko.isObservable(col.filterValue)) {
            col.filterValue = ko.observable()
          }
          col.filterTemplateNodes = ko.utils.parseHtmlFragment(ko.unwrap(col.filterTemplate))
        }
        if (typeof col.sort !== 'function') {
          col.sort = function(a, b) {
            var aText = grid.textFor(col, a),
                bText = grid.textFor(col, b)

            if (aText === bText) return 0
            return aText < bText ? -1 : 1
          }
        }
        if (!col.width) {
          col.width = ko.observable()
        }

        var template = ko.unwrap(col.template)
        if (!template) {
          template = col.link ? '<a data-bind="attr: { href: $component.linkFor($col, $data, $index) }, css: $component.classFor($col, $data, $index)"><span data-bind="frypanText: $component.textFor($col, $data, $index())"></span></a>' :
            '<span data-bind="frypanText: $component.textFor($col, $data, $index()), css: $component.classFor($col, $data, $index)"></span>'
          template = template.replace(/\$col/g, '$component.columns()[' + idx + ']')
        }
        col.templateNode = document.createElement('td')
        col.templateNode.innerHTML = template
        return col
      })
    })

    var stateProps = ['searchTerm', 'showFilters', 'sortColumn', 'sortAscending'],
    settingStorage = params.settingStorage

    if (typeof settingStorage === 'string') {
      settingStorage = function() {
        if (arguments.length) {
          localStorage.setItem(params.settingStorage, JSON.stringify(arguments[0]))
        } else {
          try {
            return JSON.parse(localStorage.getItem(params.settingStorage))
          } catch (e) {}
        }
      }
    }

    if (settingStorage) {
      var settings = settingStorage(), firstCall = true
      if (settings && typeof settings === 'object') {
        stateProps.forEach(function(prop) {
          grid[prop](prop === 'sortColumn' ? grid.columns()[settings[prop]] : settings[prop])
        })
        if (Array.isArray(settings.filters)) {
          grid.columns().forEach(function(col, colIdx) {
            col.filterValue && col.filterValue(settings.filters[colIdx])
          })
        }
      }

      computed(function() {
        var gridState = {
          filters: grid.columns().map(function(col) {
            return col.filterValue && col.filterValue()
          })
        }
        stateProps.forEach(function(prop) {
          gridState[prop] = prop === 'sortColumn' ? grid.columns().indexOf(grid[prop]()) : grid[prop]()
        })

        if (firstCall) {
          firstCall = false
          return
        }
        settingStorage(gridState)
      })
    }

    if (async) {
      var
        outstandingRequest,
        criteriaChangedDuringRequest = false,
        skip = ko.observable(0)

      // infinite scrolling
      computed(function() {
        var
          itemCount = (ko.utils.peekObservable(grid.sortedItems) || []).length,
          rowCount = grid.visibleRowCount()
        if (itemCount > rowCount && itemCount - grid.offset() < rowCount * 2) {
          skip(itemCount)
        }
      }, 5)

      var criteria = computed(function() {
        skip(0)
        return {
          searchTerm: ko.unwrap(grid.searchTerm),
          filters: grid.columns().map(function(col) {
            return col.filterValue && col.filterValue()
          }),
          sortColumn: grid.columns().indexOf(grid.sortColumn()) === -1 ? undefined : grid.sortColumn(),
          sortAscending: grid.sortAscending()
        }
      }, 1) // required to avoid recursion when updating items below

      grid.outstandingRequest = ko.observable()
      computed(function () {
        var crit = criteria()
        crit.skip = skip() // always take a dependency on these
        if (!outstandingRequest) {
          outstandingRequest = ko.unwrap(params.data).call(grid, crit)
          if (!outstandingRequest || typeof outstandingRequest.then !== 'function') {
            throw new Error('A promise was not returned from the data function')
          }

          grid.outstandingRequest(outstandingRequest)
          function notify() {
            outstandingRequest = null
            grid.outstandingRequest(null)
            if (criteriaChangedDuringRequest) {
              criteriaChangedDuringRequest = false
              criteria.notifySubscribers()
            }
          }
          outstandingRequest.then(function(items) {
            if (!Array.isArray(items)) {
              throw new Error('async request did not result in an array of items but was ' + typeof items)
            }
            if (crit.skip) {
              grid.sortedItems.splice.apply(grid.sortedItems, [crit.skip, 0].concat(items))
            } else {
              grid.sortedItems(items)
            }
            notify()
          }, notify)
        } else {
          criteriaChangedDuringRequest = true
        }
        return outstandingRequest
      }, 1)
    } else {
      var filteredItems = computed(function() {
        var items = ko.unwrap(params.$raw.data()),
            columns = grid.columns(),
            searchTerm = ko.unwrap(grid.searchTerm)

        columns.forEach(function(col) {
          if (col.filterValue && col.filterValue()) {
            items = items.filter(col.filter.bind(col, col.filterValue()))
          }
        })

        if (searchTerm) {
          var lcSearchTerm = searchTerm.toLowerCase()
          items = items.filter(function(item) {
            for (var i = 0; i < columns.length; i++) {
              var col = columns[i]
              if (typeof col.search === 'function') {
                if (col.search(item, searchTerm)) return true
              } else {
                var text = grid.textFor(col, item, i)
                if (typeof text === 'string' && text.toLowerCase().indexOf(lcSearchTerm) >= 0) return true
              }
            }
          })
        }
        return items
      }, 50)

      grid.sortedItems = computed(function() {
        var sortCol = grid.sortColumn(),
            items = filteredItems()

        if (sortCol) {
          items = items.slice()
          if (grid.sortAscending()) {
            items.sort(sortCol.sort.bind(sortCol))
          } else {
            items.sort(function() {
              return -sortCol.sort.apply(sortCol, arguments)
            })
          }
        }

        return items
      })

      grid.outstandingRequest = function() {}
    }

    grid.items = computed(function() {
      var items = grid.sortedItems()

      if (items.length >= grid.visibleRowCount()) {
        items = items.slice(grid.offset(), grid.offset() + grid.visibleRowCount())
      }

      return items
    })
  }

  Frypan.prototype.textFor = function(col, item, rowIdx) {
    var val = ko.unwrap(col && col.text)
    if (typeof val === 'string') return item && item[val]
    if (typeof val === 'function') {
      return val.call(this, item, rowIdx) || ''
    }
  }

  function getVal(prop, col, item, rowIdx) {
    var val = ko.unwrap(col && col[prop])
    if (typeof val === 'string') return val
    if (typeof val === 'function') {
      return val.call(this, item, rowIdx && rowIdx()) || ''
    }
  }
  Frypan.prototype.classFor = function(col, item, rowIdx) {
    return getVal.call(this, 'class', col, item, rowIdx)
  }
  Frypan.prototype.headerClassFor = function(col, colIdx) {
    return (getVal.call(this, 'class', col) || '') +
      (col.filterValue && col.filterValue() ? ' frypan-filtered' : '')
  }
  Frypan.prototype.linkFor = function(col, item, rowIdx) {
    return getVal.call(this, 'link', col, item, rowIdx)
  }

  Frypan.prototype.toggleSort = function(col) {
    if (col === this.sortColumn()) {
      this.sortAscending(!this.sortAscending())
    } else {
      this.sortColumn(col)
    }
  }

  Frypan.prototype.ariaSortForCol = function(col) {
    if (this.sortColumn() === col) {
      return this.sortAscending() ? 'ascending' : 'descending'
    }
  }

  Frypan.prototype.toggleShowFilters = function(idx) {
    idx = ko.unwrap(idx)
    this.showFilters(this.showFilters() === idx ? null : idx)
  }

  Frypan.prototype.width = function() {
    return this.columns().reduce(function(width, col) {
      return width + col.width()
    }, 0)
  }

  var cleanse = document.createElement('div')
  ko.bindingHandlers.frypanText = {
    update: function(element, valueAccessor, _, __, bindingContext) {
      var text = ko.unwrap(valueAccessor()),
          term = bindingContext.$component.searchTerm()
      if (term && typeof text === 'string' && text.indexOf(term) >= 0) {
        cleanse.textContent = text
        element.innerHTML = cleanse.innerHTML.replace(term, '<em>' + term + '</em>')
      } else {
        element.textContent = text != null ? text : ''
      }
    }
  }

  ko.bindingHandlers.frypanFilter = {
    init: function(element, valueAccessor, __, ___, bindingContext) {
      element.addEventListener('click', function(e) {
        e.preventDefault()
        bindingContext.$component.toggleShowFilters(bindingContext.$index)
      })
      if (bindingContext.$component.filterToggleTemplate) {
        element.innerHTML = bindingContext.$component.filterToggleTemplate
      }
    }
  }

  ko.bindingHandlers.frypanRow = {
    init: function(element, _, __, ___, bindingContext) {
      if (bindingContext.$component.rowClick) {
        element.addEventListener('click', function(e) {
          if (bindingContext.$component.rowClick(bindingContext.$data, e)) {
            e.preventDefault()
          }
        })
      }
      return { controlsDescendantBindings: true }
    },
    update: function(element, _, __, ___, bindingContext) {
      var children = Array.prototype.slice.call(element.childNodes)
      children.forEach(function(node) {
        ko.cleanNode(element)
        element.removeChild(node)
      })
      bindingContext.$component.columns().forEach(function(col) {
        var td = col.templateNode.cloneNode(true)
        ko.cleanNode(td)
        element.appendChild(td)
      })
      ko.applyBindingsToDescendants(bindingContext, element)
    }
  }

  // dynamically figure the size of the table by letting the thead size naturally from CSS or however
  // the user chooses to do that, and then fix the column widths from that, and width and height from the `frypan` container
  ko.bindingHandlers.frypanVirtualization = {
    init: function(tbody, valueAccessor, allBindingsAccessor, rootViewModel, bindingContext) {
      var
        table = tbody.parentElement,
        scrollArea = table.parentElement,
        frypan = scrollArea.parentElement,
        frypanStyle = getComputedStyle(frypan),
        overflowY = frypanStyle['overflow-y'],
        grid = bindingContext.$component,
        thead = table.querySelector('thead'),
        td = table.querySelector('tbody td'),
        rowHeight, sub, pegWidthComputed

      if (overflowY === 'auto' || overflowY === 'scroll') {
        var
          topSpacer = table.querySelector('.frypan-top-spacer'),
          bottomSpacer = table.querySelector('.frypan-bottom-spacer')

        if (!td) {
          sub = grid.sortedItems.subscribe(function() {
            var td = table.querySelector('tbody td')
            if (td) {
              sub.dispose()
              setup(td)
            }
          })
        } else {
          setup(td)
        }
      }
      if (!bottomSpacer && ko.unwrap(grid.resizableColumns)) {
        if (!td) {
          sub = grid.sortedItems.subscribe(function() {
            sub.dispose()
            pegWidths()
          })
        } else {
          pegWidths()
        }
      }

      function calcThWidths() {
        var thWidths = Array.prototype.map.call(thead.querySelectorAll('th'), function(th) {
          return th.offsetWidth
        }),
        tdWidths = Array.prototype.map.call(tbody.querySelectorAll('tr:first-child td'), function(td) {
          return td.offsetWidth
        }),
        columns = grid.columns()
        for (var i = 0; i < columns.length; i++) {
          columns[i].width(Math.max(thWidths[i] || 0, tdWidths[i] || 0))
        }
      }

      function pegWidths() {
        if (!pegWidthComputed) {
          pegWidthComputed = ko.computed(calcThWidths, null, { disposeWhenNodeIsRemoved: table })
        } else {
          calcThWidths()
        }
        table.style['table-layout'] = 'fixed'
        table.style['border-spacing'] = '0'
        table.style.width = '1px'
      }

      function setup(td) {
        rowHeight = td.offsetHeight
        if (frypanStyle.display !== 'flex') {
          scrollArea.style.height = '100%'
        }
        scrollArea.style['overflow'] = overflowY
        frypan.style['overflow'] = 'hidden'

        tbody.style.height = scrollArea.offsetHeight - thead.offsetHeight
        topSpacer.style.display = 'block'
        bottomSpacer.style.display = 'block'

        // Peg the widths of the columns before we float the table header,
        // since when we do it will change
        pegWidths()

        scrollArea.parentElement.style.position = 'relative'
        thead.style.position = 'absolute'
        thead.style.top = 0
        thead.style.left = 0

        updateVisibleRowCount()
        ko.computed(function() {
          updateOffset(grid)
        }, null, { disposeWhenNodeIsRemoved: tbody })

        scrollArea.addEventListener('scroll', updateOffset.bind(null, grid))

        var pendingResize, sizeAtStart = window.innerWidth,
        resizeListener = function (e) {
          updateVisibleRowCount()
          if (!grid.resizableColumns) {
            resizeGrid()
          } else {
            if (pendingResize) {
              clearTimeout(pendingResize)
            }
            pendingResize = setTimeout(function() {
              pendingResize = null
              var delta = window.innerWidth - sizeAtStart
              sizeAtStart = window.innerWidth

              for (var len = grid.columns().length, d = Math.floor(delta / len), i = 0; i < len; i++) {
                var w = grid.columns()[i].width
                w(w() + d + (i === 0 ? delta % len : 0))
              }
            }, 100)
          }
        }
        window.addEventListener('resize', resizeListener)

        ko.utils.domNodeDisposal.addDisposeCallback(table, function() {
          window.removeEventListener('resize', resizeListener)
        })
      }

      function resizeGrid() {
        table.style['table-layout'] = ''
        table.style['border-spacing'] = ''
        table.style.width = ''
        thead.style.position = ''
        grid.columns().forEach(function(c) { c.width(null) })
        calcThWidths()
        table.style.width = grid.columns().reduce(function(sum, c) { return sum + c.width() }, 0) + 'px'
        thead.style.position = 'absolute'
      }

      function updateVisibleRowCount() {
        var visibleRowCount = Math.ceil((scrollArea.clientHeight - thead.offsetHeight - 1) / rowHeight) + 1
        grid.visibleRowCount(visibleRowCount)
      }

      function updateOffset(grid) {
        var
          offset = Math.floor(Math.max(0, scrollArea.scrollTop) / rowHeight),
          topSpacerHeight = (offset * rowHeight) + thead.offsetHeight

        grid.offset(offset)
        topSpacer.style.height = topSpacerHeight + 'px'
        bottomSpacer.style.height = Math.max(0, (grid.sortedItems().length - offset - grid.visibleRowCount()) * rowHeight) + 'px'
        thead.style.left = -scrollArea.scrollLeft + 'px'
      }
    }
  }

  ko.bindingHandlers.frypanResizer = {
    init: function(element, valueAccessor, __, ___, bindingContext) {
      element.addEventListener('mousedown', function(downEvent) {
        downEvent.preventDefault()
        element.classList.add('frypan-resizing')

        var
          width = valueAccessor(),
          intialWidth = width(),
          startMouseX = downEvent.pageX,
          targetMouseX, animationFrameRequest

        function onMouseMove(moveEvent) {
          targetMouseX = moveEvent.pageX
          if (animationFrameRequest) {
            cancelAnimationFrame(animationFrameRequest)
          }
          animationFrameRequest = requestAnimationFrame(function() {
            width(Math.max(15, intialWidth - startMouseX + targetMouseX))
          })
          moveEvent.preventDefault()
        }

        function onMouseUp() {
          if (animationFrameRequest) {
            cancelAnimationFrame(animationFrameRequest)
          }
          element.classList.remove('frypan-resizing')
          document.removeEventListener('mousemove', onMouseMove)
          document.removeEventListener('mouseup', onMouseUp)
        }

        document.addEventListener('mousemove', onMouseMove)
        document.addEventListener('mouseup', onMouseUp)
      })
    }
  }

  // the css binding is being used by `rowClass` so we use a custom simple class binding
  // well simplier if IE10 and PhantomJS supported classList fully
  ko.bindingHandlers.frypanAlt = {
    update: function(element, valueAccessor) {
      element.classList[valueAccessor() % 2 === 1 ? 'add' : 'remove']('frypan-odd')
    }
  }

  ko.components.register('frypan', {
    template: '<div class="frypan-scroll-area">\
<table>\
  <colgroup data-bind="foreach: $component.columns"><col data-bind="style: { width: $data.width() && $data.width() + \'px\' }"></col></colgroup>\
  <thead data-bind="style: { width: $component.width() + \'px\' }"><tr data-bind="foreach: $component.columns">\
    <th data-bind="css: $component.headerClassFor($data, $index()), animation: { when: $component.showFilters() === $index(), class: \'frypan-filter-open\', enter: \'frypan-filter-opening\', exit: \'frypan-filter-closing\' }, attr: { \'aria-sort\': $component.ariaSortForCol($data) }, style: { width: $data.width() && $data.width() + \'px\' }">\
      <a href="" class="frypan-sort-toggle" data-bind="text: name, click: $component.toggleSort.bind($component)"></a>\
      <!-- ko if: $data.filterTemplateNodes -->\
        <a href="" class="frypan-filter-toggle" data-bind="frypanFilter:true"></a>\
        <div class="frypan-filters" data-bind="template: { nodes: $data.filterTemplateNodes }"></div>\
      <!-- /ko -->\
      <!-- ko if: $component.resizableColumns --><a class="frypan-resizer" data-bind="frypanResizer: $data.width"></a><!-- /ko -->\
    </th></tr>\
  </thead>\
  <tbody class="frypan-top-spacer" style="display: none;">\
  <tbody data-bind="foreach: items, frypanVirtualization: true"><tr data-bind="frypanRow: true, css: $component.rowClass && $component.rowClass($data, $index), frypanAlt: $component.offset() + $index()"></tr></tbody>\
  <tbody class="frypan-bottom-spacer" style="display: none;">\
</table></div>\
<div class="frypan-loader" data-bind="css: { \'frypan-loading\': outstandingRequest() }, html: $component.loadingHtml"></div>',

    viewModel: {
      createViewModel: function(params, componentInfo) {
        var loadingTemplate = componentInfo.templateNodes.filter(function(n) {
          return n.tagName === 'FRYPAN-LOADER'
        })[0]

        if (loadingTemplate) {
          params.loadingHtml = loadingTemplate.innerHTML
        }

        componentInfo.templateNodes.filter(function(n) {
          return n.tagName === 'FRYPAN-COLUMN'
        }).forEach(function(n, idx) {
          var colName = n.getAttribute('name'),
          col = colName ? (params.columns || []).filter(function(c) { return c.name === colName })[0] : params.columns[idx]
          if (col) {
            col.template = n.innerHTML
          } else {
            if (!Array.isArray(params.columns)) {
              params.columns = []
            }
            params.columns.push({ name: colName, template: n.innerHTML })
          }
        })

        var frypan = new Frypan(params),
        closeFiltersIfNeeded = function(e) {
          if (e.target && !componentInfo.element.contains(e.target)) {
            frypan.showFilters(null)
          }
        }
        document.body.addEventListener('click', closeFiltersIfNeeded)
        ko.utils.domNodeDisposal.addDisposeCallback(componentInfo.element, function() {
          document.body.removeEventListener('click', closeFiltersIfNeeded)
        })

        return frypan
      }
    },
    synchronous: true
  })

  return Frypan
})