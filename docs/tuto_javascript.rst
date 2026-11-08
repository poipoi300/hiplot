.. _tutoJavascript:

NPM library (javascript)
===============================

HiPlot is released as a React component in an `NPM package <https://www.npmjs.com/package/hiplot-plus>`_, and can be embedded in any javascript/React codebase.

.. warning::

    The Javascript library API is very recent, subject to changes, and less used compared to the python API. Please report any bug or suggestion in the `issue tracker <https://github.com/poipoi300/hiplot/issues>`_



Getting started
----------------------------------

Download hiplot in your favorite package manager

>>> npm install hiplot-plus  # if using npm
>>> yarn add hiplot-plus # for yarn users


Basic example
-----------------------------------


.. literalinclude:: ../examples/javascript/src/index.js
    :language: text
    :start-after: BEGIN_DOC_BASIC_EXAMPLE
    :end-before: END_DOC_BASIC_EXAMPLE



.. raw:: html

    <iframe src="./_static/examples_javascript/Basic/index.html?hip.theme=light" height="700px" width="100%"></iframe>


Customizing HiPlot react component
-----------------------------------

There are two main ways to customize your HiPlot component:

- Either by changing information in the ``experiment`` object itself
    For instance, the color map, data types, order/hidden columns in Parallel Plot can be set this way (the related python tutorial can be a good start: :ref:`customizeXp`)
- Or by setting HiPlot's component properties
    For instance, it is possible to remove the table, or switch to dark mode (see :ref:`tutoJSAdvanced`)


React properties
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

.. literalinclude:: ../src/component.tsx
    :language: text
    :start-after: BEGIN_HIPLOT_PROPS
    :end-before: END_HIPLOT_PROPS


.. _tutoJSAdvanced:

An advanced example
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

.. literalinclude:: ../examples/javascript/src/index.js
    :language: text
    :start-after: BEGIN_DOC_CUSTOM_EXAMPLE
    :end-before: END_DOC_CUSTOM_EXAMPLE


.. raw:: html

    <iframe src="./_static/examples_javascript/Custom/index.html?hip.PARALLEL_PLOT.height=250&amp;hip.theme=light" height="400px" width="100%"></iframe>
